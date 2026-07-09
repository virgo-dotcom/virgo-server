// ============================================================
//  VIRGO: Space Dominion — Game Server
//  Node.js Server für Render.com
//  Ersetzt PlayFab CloudScript für Spiellogik
//
//  ÄNDERUNG (Juli 2026) — zwei Themen behoben:
//
//  1) /processFleet hat bisher die verarbeitete Flotte NIE aus
//     commander.activeFleets entfernt und eine neu erzeugte
//     Rückflug-Flotte NIE gespeichert ("Geister-Flotten", verlorene
//     Rückflüge). Jetzt wie /serverTick: splice + push.
//
//  2) Kampf war nur eine grobe Platzhalter-Rechnung ohne echte
//     Verteidigung (defWarships war immer [0,...,0]) und ohne
//     vollständigen Kampfbericht (kein Schild, keine Verluste pro
//     Schiffstyp, kein Recycling/Reparatur/Erfahrung). Das ist jetzt
//     eine vollständige Portierung der Kampf-Formeln aus
//     CombatManager.cs (Client-Vorschau), inkl. echtem CombatReport-
//     Objekt, das direkt in mail.reportData landet und von
//     CombatReportController.OpenReportFromMail() angezeigt werden kann.
//
//     Um die Verteidiger-Schiffe eines Zielplaneten lesen zu können,
//     muss der Server wissen, welchem PlayFab-Account der Planet
//     gehört. Dafür wird jetzt das Feld "pfid" aus den öffentlichen
//     Planetendaten (sys_G_S_S Title Data, siehe CloudScript) genutzt.
//     Für NPC-Ziele (900001/900002) gibt es noch keinen echten
//     PlayFab-Account — dort bleibt die Verteidigung vorerst 0
//     (bekannte, bereits auf der Roadmap stehende Einschränkung:
//     "NPC-Accounts betretbar machen").
// ============================================================

const express = require('express');
const axios   = require('axios');
const app     = express();

app.use(express.json());

// PlayFab Konfiguration
const PLAYFAB_TITLE_ID  = '192413';
const PLAYFAB_SECRET    = process.env.PLAYFAB_SECRET_KEY;
const PLAYFAB_BASE_URL  = `https://${PLAYFAB_TITLE_ID}.playfabapi.com`;

// -------------------------------------------------------
// Schiffs-Basiswerte (Alpha-Scope: Warship01-04)
// Quelle: PROJEKT_ZUSAMMENFASSUNG (Schiffswerte-Tabelle)
// Index 0-3 = Warship01-04. Index 4-9 (WS05-10) sind in der Alpha
// noch nicht im Einsatz und bleiben auf 0.
// -------------------------------------------------------
const SHIP_WEAPON = [
    [10, 2, 0],      // Warship01
    [31, 10, 4],     // Warship02
    [92, 37, 18],    // Warship03
    [268, 131, 74],  // Warship04
    [0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]
];
const SHIP_SHIELD = [
    [3, 1, 0],       // Warship01
    [8, 2, 1],       // Warship02
    [23, 9, 4],      // Warship03
    [67, 33, 19],    // Warship04
    [0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]
];
const SHIP_BUILD_COST = [100, 300, 900, 2700, 8100, 24300, 72900, 218700, 656100, 1968300];
const HP_MULT_FIGHTER = 3.1;  // Warship01-03
const HP_MULT_CARRIER = 4.1;  // Warship04-10

const SHIELD_BUILDING_INDEX   = 10;   // Building10
const SHIELD_HP_PER_LEVEL     = 5000;
const IRON_RESERVE_PER_LEVEL  = 1000;
const RECYCLING_BASE          = 0.10;
const REPAIR_BASE             = 0.10;
const LOSER_LOSS_MIN          = 0.45;
const LOSER_LOSS_MAX          = 0.55;
const WINNER_LOSS_BASE        = 0.10;
const WINNER_LOSS_MAX         = 0.35;

// -------------------------------------------------------
// Health Check
// -------------------------------------------------------
app.get('/', (req, res) => {
    res.json({ status: 'VIRGO Server läuft', time: new Date().toISOString() });
});

// -------------------------------------------------------
// PlayFab Server API Hilfsfunktion
// -------------------------------------------------------
async function playfabServer(endpoint, data) {
    const response = await axios.post(`${PLAYFAB_BASE_URL}${endpoint}`, data, {
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': PLAYFAB_SECRET
        }
    });
    return response.data.data;
}

// -------------------------------------------------------
// Flotte verarbeiten (Kampf, Rückflug, etc.)
// Wird von Unity aufgerufen, sobald eine Flotte (clientseitig
// erkannt) angekommen ist.
// -------------------------------------------------------
app.post('/processFleet', async (req, res) => {
    const { playFabId, fleetId } = req.body;
    if (!playFabId || !fleetId)
        return res.status(400).json({ error: 'playFabId und fleetId erforderlich' });

    try {
        const userData = await playfabServer('/Server/GetUserData', {
            PlayFabId: playFabId,
            Keys: ['commander_data']
        });

        if (!userData.Data || !userData.Data['commander_data'])
            return res.status(404).json({ error: 'Commander nicht gefunden' });

        const commander = JSON.parse(userData.Data['commander_data'].Value);
        const now = new Date();

        if (!commander.activeFleets) commander.activeFleets = [];

        const fleetIndex = commander.activeFleets.findIndex(f => f.fleetId === fleetId);

        // Flotte nicht (mehr) vorhanden -> wurde vermutlich schon von
        // /serverTick oder einem parallelen Aufruf verarbeitet. Kein Fehler.
        if (fleetIndex === -1) {
            return res.json({ success: true, message: 'Flotte nicht (mehr) vorhanden, vermutlich bereits verarbeitet' });
        }

        const fleet = commander.activeFleets[fleetIndex];

        // Geister-Flotte aus einem alten Client-Stand (hasArrived=true, aber
        // nie aus der Liste entfernt) -> jetzt bereinigen und Schluss.
        if (fleet.hasArrived) {
            commander.activeFleets.splice(fleetIndex, 1);
            await playfabServer('/Server/UpdateUserData', {
                PlayFabId: playFabId,
                Data: { 'commander_data': JSON.stringify(commander) },
                Permission: 'Private'
            });
            return res.json({ success: true, message: 'Geister-Flotte bereinigt (war bereits verarbeitet)' });
        }

        // Noch nicht angekommen?
        if (new Date(fleet.arrivalUtc) > now) {
            return res.json({
                success: false,
                message: 'Noch nicht angekommen',
                remainingSeconds: (new Date(fleet.arrivalUtc) - now) / 1000
            });
        }

        // Flotte verarbeiten (Kampf oder Rückflug-Landung)
        const returnFleet = await processFleetArrival(playFabId, commander, fleet, now);

        // WICHTIG: alte Flotte aus der Liste entfernen,
        // ggf. neue Rückflug-Flotte hinzufügen (wie in /serverTick)
        commander.activeFleets.splice(fleetIndex, 1);
        if (returnFleet) commander.activeFleets.push(returnFleet);

        // Commander speichern
        await playfabServer('/Server/UpdateUserData', {
            PlayFabId: playFabId,
            Data: { 'commander_data': JSON.stringify(commander) },
            Permission: 'Private'
        });

        res.json({ success: true, returnFleetCreated: !!returnFleet });

    } catch (error) {
        console.error('[Server] Fehler:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// -------------------------------------------------------
// Server Tick (alle 5 Minuten von außen aufrufen)
// -------------------------------------------------------
app.post('/serverTick', async (req, res) => {
    const log = [];
    const now = new Date();

    try {
        // ActivePlayerIds laden
        const titleData = await playfabServer('/Server/GetTitleData', { Keys: ['ActivePlayerIds'] });
        let activeIds = [];
        try {
            const raw = titleData.Data['ActivePlayerIds'] || '[]';
            activeIds = JSON.parse(raw);
        } catch(e) { activeIds = []; }

        log.push(`Spieler: ${activeIds.length}`);

        // Jeden Spieler verarbeiten
        for (const playFabId of activeIds) {
            try {
                const userData = await playfabServer('/Server/GetUserData', {
                    PlayFabId: playFabId,
                    Keys: ['commander_data']
                });

                if (!userData.Data?.['commander_data']) continue;

                const commander = JSON.parse(userData.Data['commander_data'].Value);
                let changed = false;

                // Ressourcen produzieren
                if (commander.colonies?.length > 0) {
                    for (const coord of commander.colonies) {
                        const planetKey = `planet_${coord.replace(/:/g, '_')}`;
                        try {
                            const pData = await playfabServer('/Server/GetUserData', {
                                PlayFabId: playFabId,
                                Keys: [planetKey]
                            });
                            if (!pData.Data?.[planetKey]) continue;

                            const planet = JSON.parse(pData.Data[planetKey].Value);
                            const updatedPlanet = produceResources(planet, 300); // 5 Minuten

                            await playfabServer('/Server/UpdateUserData', {
                                PlayFabId: playFabId,
                                Data: { [planetKey]: JSON.stringify(updatedPlanet) },
                                Permission: 'Private'
                            });
                        } catch(e) {}
                    }
                }

                // Flotten verarbeiten
                if (commander.activeFleets?.length > 0) {
                    const returnFleets = [];
                    const toRemove = [];

                    for (let f = 0; f < commander.activeFleets.length; f++) {
                        const fleet = commander.activeFleets[f];
                        if (!fleet || !fleet.arrivalUtc) continue;
                        if (fleet.hasArrived) { toRemove.push(f); continue; }
                        if (new Date(fleet.arrivalUtc) > now) continue;

                        commander.activeFleets[f].hasArrived = true;
                        const missionNum = fleet.mission;

                        if (missionNum === 3 || missionNum === 'Attack') {
                            const returnFleet = await resolveCombat(playFabId, commander, fleet, now, log);
                            if (returnFleet) returnFleets.push(returnFleet);
                        } else if (missionNum === 10 || missionNum === 'Return') {
                            await processReturn(playFabId, commander, fleet, log);
                        }

                        toRemove.push(f);
                        changed = true;
                    }

                    // Verarbeitete entfernen
                    for (let r = toRemove.length - 1; r >= 0; r--)
                        commander.activeFleets.splice(toRemove[r], 1);

                    // Rückflüge hinzufügen
                    for (const rf of returnFleets)
                        commander.activeFleets.push(rf);
                }

                // Forschung prüfen
                if (commander.activeResearch?.endTimeUtc &&
                    new Date(commander.activeResearch.endTimeUtc) <= now) {
                    applyResearch(commander, commander.activeResearch.type, commander.activeResearch.targetLevel);
                    commander.activeResearch = null;
                    changed = true;
                    log.push(`Forschung fertig: ${playFabId}`);
                }

                if (changed) {
                    await playfabServer('/Server/UpdateUserData', {
                        PlayFabId: playFabId,
                        Data: { 'commander_data': JSON.stringify(commander) },
                        Permission: 'Private'
                    });
                    log.push(`Commander gespeichert: ${playFabId}`);
                }

            } catch(e) {
                log.push(`Fehler bei ${playFabId}: ${e.message}`);
            }
        }

    } catch(e) {
        log.push(`Tick Fehler: ${e.message}`);
    }

    res.json({ success: true, log, timestamp: now.toISOString() });
});

// -------------------------------------------------------
// Ressourcenproduktion
// -------------------------------------------------------
function produceResources(planet, elapsedSeconds) {
    const ticks = Math.floor(elapsedSeconds / 5);
    if (ticks <= 0) return planet;
    const cap = (planet.buildings[0] || 1) * 100000;
    const bld00 = planet.buildings[0] || 0;
    if (bld00 > 0) {
        planet.ressources[0] = Math.min((planet.ressources[0] || 0) + 25 * bld00 * ticks, cap);
        planet.ressources[1] = Math.min((planet.ressources[1] || 0) + 50 * bld00 * ticks, cap);
        planet.ressources[2] = Math.min((planet.ressources[2] || 0) + 200 * bld00 * ticks, cap);
        planet.ressources[3] = Math.min((planet.ressources[3] || 0) + 100 * bld00 * ticks, cap);
        planet.ressources[4] = Math.min((planet.ressources[4] || 0) + 1 * bld00 * ticks, 1000);
    }
    return planet;
}

// =========================================================
// KAMPF-HILFSFUNKTIONEN (Portierung aus CombatManager.cs)
// =========================================================

function sumArray(arr) {
    return (arr || []).reduce((a, b) => a + (b || 0), 0);
}

// Flottenbonus (max +40%) — geometrische Kette WS04 -> WS03 -> WS02 -> WS01
function calculateFleetBonus(warships) {
    const ws04 = warships[3] || 0;
    const ws03 = warships[2] || 0;
    const ws02 = warships[1] || 0;
    const ws01 = warships[0] || 0;

    const cap03 = ws04 * 2;
    const cap02 = Math.min(ws03, cap03) * 2;
    const cap01 = Math.min(ws02, cap02) * 2;

    const eff03 = Math.min(ws03, cap03);
    const eff02 = Math.min(ws02, cap02);
    const eff01 = Math.min(ws01, cap01);

    const b04 = ws04 > 0 ? 0.10 : 0;
    const b03 = cap03 > 0 ? 0.10 * (eff03 / cap03) : 0;
    const b02 = cap02 > 0 ? 0.10 * (eff02 / cap02) : 0;
    const b01 = cap01 > 0 ? 0.10 * (eff01 / cap01) : 0;

    return Math.min(b04 + b03 + b02 + b01, 0.40);
}

// Schiffsstärke (Angriffskraft) inkl. Waffen-Forschungsboni
function calculateShipStrength(warships, ships, commander) {
    let strength = 0;
    const w1 = 1 + ((commander?.weapon01 || 0) * 0.01);
    const w2 = 1 + ((commander?.weapon02 || 0) * 0.01);
    const w3 = 1 + ((commander?.weapon03 || 0) * 0.01);

    for (let i = 0; i < 10; i++) {
        const n = warships[i] || 0;
        if (n <= 0) continue;
        const [wp1, wp2, wp3] = SHIP_WEAPON[i];
        strength += (wp1 * w1 + wp2 * w2 + wp3 * w3) * n;
    }
    for (let i = 0; i < (ships ? ships.length : 0); i++) {
        const n = ships[i] || 0;
        if (n > 0) strength += n * 10;
    }
    return strength;
}

// Schiffs-HP inkl. Schild-Forschungsboni
function calculateShipHP(warships, ships, commander) {
    let totalHP = 0;
    const s1 = 1 + ((commander?.shield01 || 0) * 0.01);
    const s2 = 1 + ((commander?.shield02 || 0) * 0.01);
    const s3 = 1 + ((commander?.shield03 || 0) * 0.01);

    for (let i = 0; i < 10; i++) {
        const n = warships[i] || 0;
        if (n <= 0) continue;
        const [sh1, sh2, sh3] = SHIP_SHIELD[i];
        const shieldSum = sh1 * s1 + sh2 * s2 + sh3 * s3;
        const hpMult = i < 3 ? HP_MULT_FIGHTER : HP_MULT_CARRIER;
        totalHP += shieldSum * hpMult * n;
    }
    for (let i = 0; i < (ships ? ships.length : 0); i++) {
        const n = ships[i] || 0;
        if (n > 0) totalHP += n * 100;
    }
    return totalHP;
}

// Sieger-Verluste (weniger bei großer Überlegenheit)
function calculateWinnerLoss(strengthRatio) {
    if (strengthRatio >= 3)   return WINNER_LOSS_BASE * 0.5;
    if (strengthRatio >= 2)   return WINNER_LOSS_BASE * 0.75;
    if (strengthRatio >= 1.5) return WINNER_LOSS_BASE;
    if (strengthRatio >= 1)   return WINNER_LOSS_BASE + (WINNER_LOSS_MAX - WINNER_LOSS_BASE) * 0.5;
    return WINNER_LOSS_MAX;
}

// Verluste anwenden (nie 100%, mind. 1 Überlebender pro Typ mit Bestand > 0)
function applyLosses(beforeArr, lossPercent) {
    return (beforeArr || []).map(n => {
        const before = n || 0;
        if (before <= 0) return 0;
        let losses = Math.floor(before * lossPercent);
        const minSurvivors = Math.max(1, Math.floor(before * 0.01));
        losses = Math.min(losses, before - minSurvivors);
        return before - losses;
    });
}

function buildParticipant(commander, fleetId, isAttacker, isStationed, isPlanetOwner,
                           warshipsBefore, shipsBefore, warshipsAfter, shipsAfter,
                           bonusPercent, bonusTarget) {
    const totalBefore = sumArray(warshipsBefore) + sumArray(shipsBefore);
    const totalAfter  = sumArray(warshipsAfter) + sumArray(shipsAfter);
    const totalLosses = Math.max(0, totalBefore - totalAfter);

    const p = {
        commanderId: commander ? commander.commanderId : 0,
        commanderName: commander ? commander.visibleName : 'Unbekannt',
        fleetId: fleetId || null,
        isPlanetOwner: isPlanetOwner,
        isStationedFleet: isStationed,
        isAttacker: isAttacker,
        warshipsBefore: [...warshipsBefore],
        warshipsAfter: [...warshipsAfter],
        warshipsRepaired: new Array(10).fill(0),
        shipsBefore: [...shipsBefore],
        shipsAfter: [...shipsAfter],
        shipsRepaired: new Array(6).fill(0),
        totalShipsBefore: totalBefore,
        totalShipsAfter: totalAfter,
        totalLosses: totalLosses,
        totalRepaired: 0,
        lossPercentage: totalBefore > 0 ? (totalLosses / totalBefore) * 100 : 0,
        bonuses: [],
        debuffs: []
    };
    if (bonusPercent > 0) {
        p.bonuses.push({ name: 'Flottenbonus', target: bonusTarget, percent: bonusPercent * 100 });
    }
    return p;
}

function recalcParticipantLosses(participant, before10, beforeShips, after10, afterShips) {
    let losses = 0;
    for (let i = 0; i < 10; i++) losses += Math.max(0, (before10[i] || 0) - (after10[i] || 0));
    for (let i = 0; i < 6; i++)  losses += Math.max(0, (beforeShips[i] || 0) - (afterShips[i] || 0));
    participant.warshipsAfter  = [...after10];
    participant.shipsAfter     = [...afterShips];
    participant.totalShipsAfter = sumArray(after10) + sumArray(afterShips);
    participant.totalLosses    = losses;
    participant.lossPercentage = participant.totalShipsBefore > 0
        ? (losses / participant.totalShipsBefore) * 100
        : 0;
}

function formatTimestamp(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}. ${hh}:${mi}`;
}

// Ermittelt Besitzer-Commander-ID + PlayFabId eines Zielplaneten über
// die öffentlichen Systemdaten (sys_G_S_S). pfid ist dort NUR für den
// Render Server sichtbar (der Client-Handler GetSystemPublicData
// filtert es immer heraus, siehe CloudScript).
async function getPlanetOwnerInfo(coord) {
    const parts = coord.split(':');
    if (parts.length !== 4) return null;
    const [g, s, sys, pStr] = parts;
    const planetNum = parseInt(pStr, 10);
    const systemKey = `sys_${g}_${s}_${sys}`;
    try {
        const result = await playfabServer('/Server/GetTitleData', { Keys: [systemKey] });
        const raw = result.Data?.[systemKey];
        if (!raw) return null;
        const systemData = JSON.parse(raw);
        const entry = (systemData.planets || []).find(p => p.n === planetNum);
        if (!entry) return null;
        return {
            ownerCommanderId: entry.owner,
            ownerName: entry.name,
            pfid: entry.pfid || null,
            hqLevel: entry.hq || 0
        };
    } catch (e) {
        return null;
    }
}

// =========================================================
// KAMPF AUFLÖSEN (ersetzt die alte processAttack-Platzhalterlogik)
// =========================================================
async function resolveCombat(attackerPlayFabId, attackerCommander, attackerFleet, now, log = []) {
    const destCoord = attackerFleet.destinationCoord;
    const ownerInfo = await getPlanetOwnerInfo(destCoord);

    const isRealPlayerDefender = !!(ownerInfo && ownerInfo.pfid && ownerInfo.ownerCommanderId < 900000);

    let defenderPfid = null;
    let defenderCommander = null;
    let defenderPlanet = null;
    let defenderPlanetKey = null;

    if (isRealPlayerDefender) {
        defenderPfid = ownerInfo.pfid;
        defenderPlanetKey = `planet_${destCoord.replace(/:/g, '_')}`;
        try {
            const defData = await playfabServer('/Server/GetUserData', {
                PlayFabId: defenderPfid,
                Keys: ['commander_data', defenderPlanetKey]
            });
            if (defData.Data?.['commander_data']) defenderCommander = JSON.parse(defData.Data['commander_data'].Value);
            if (defData.Data?.[defenderPlanetKey]) defenderPlanet = JSON.parse(defData.Data[defenderPlanetKey].Value);
        } catch (e) {
            log.push(`Verteidiger-Daten nicht lesbar: ${e.message}`);
        }
    }

    // Ohne echte Verteidiger-Planetendaten (NPC oder Fehler) bleibt die
    // Verteidigung bei 0 — bekannte, dokumentierte Einschränkung.
    const defWarships  = defenderPlanet ? [...defenderPlanet.warships] : [0,0,0,0,0,0,0,0,0,0];
    const defShips     = defenderPlanet ? [...defenderPlanet.ships]    : [0,0,0,0,0,0];
    const defBuildings = defenderPlanet ? defenderPlanet.buildings     : [];

    const report = {
        reportId: `CR-${ownerInfo ? ownerInfo.ownerCommanderId : 0}-${now.getTime()}`,
        timestamp: formatTimestamp(now),
        unixTimestamp: Math.floor(now.getTime() / 1000),
        planetCoord: destCoord,
        planetOwnerId: ownerInfo ? ownerInfo.ownerCommanderId : -1,
        planetOwnerName: ownerInfo ? ownerInfo.ownerName : 'Unbekannt',
        attackers: [],
        defenders: [],
        totalAttackerShips: 0,
        totalDefenderShips: 0,
        totalAttackerLosses: 0,
        totalDefenderLosses: 0,
        attackerWins: false,
        shieldHeld: false,
        loot: [0,0,0,0,0],
        totalLootValue: 0,
        recycling: [0,0,0,0,0],
        ress05Attacker: 0,
        ress05Defender: 0,
        combatDurationSeconds: 5,
        shieldLevelBefore: 0,
        shieldLevelAfter: 0,
        shieldHP: 0,
        attackerStrengthVsShield: 0
    };

    const attackerFleetBonus  = calculateFleetBonus(attackerFleet.warships);
    const attackerStrengthRaw = calculateShipStrength(attackerFleet.warships, attackerFleet.ships, attackerCommander)
                                * (1 + attackerFleetBonus);

    // PHASE 1: Planetares Schild (nur wenn echte Verteidiger-Daten vorliegen)
    if (defenderPlanet && (defBuildings[SHIELD_BUILDING_INDEX] || 0) > 0) {
        const shieldLevel = defBuildings[SHIELD_BUILDING_INDEX];
        const shieldHP = shieldLevel * SHIELD_HP_PER_LEVEL;
        report.shieldLevelBefore = shieldLevel;
        report.shieldHP = shieldHP;
        report.attackerStrengthVsShield = attackerStrengthRaw;

        if (attackerStrengthRaw <= shieldHP) {
            report.shieldHeld = true;
            report.shieldLevelAfter = shieldLevel;
            report.attackerWins = false;

            const p = buildParticipant(attackerCommander, attackerFleet.fleetId, true, false, false,
                attackerFleet.warships, attackerFleet.ships || [0,0,0,0,0,0],
                attackerFleet.warships, attackerFleet.ships || [0,0,0,0,0,0],
                attackerFleetBonus, 'Stärke');
            report.attackers.push(p);
            report.totalAttackerShips += p.totalShipsBefore;

            sendCombatMail(attackerCommander, report, true);
            if (defenderPfid && defenderCommander) {
                sendCombatMail(defenderCommander, report, false);
                try {
                    await playfabServer('/Server/UpdateUserData', {
                        PlayFabId: defenderPfid,
                        Data: { 'commander_data': JSON.stringify(defenderCommander) },
                        Permission: 'Private'
                    });
                } catch (e) {}
            }

            log.push(`Kampf: ${attackerFleet.fleetId} | Schild hielt, Angreifer zieht zurück`);

            // Angreifer fliegt unverändert zurück (kein Kampf stattgefunden)
            return buildReturnFleet(attackerFleet, now, [...attackerFleet.warships], [0,0,0,0,0]);
        } else {
            defBuildings[SHIELD_BUILDING_INDEX] = Math.max(0, shieldLevel - 1);
            report.shieldLevelAfter = defBuildings[SHIELD_BUILDING_INDEX];
        }
    }

    // PHASE 2+3: Stärke & HP
    const attackerStrength = attackerStrengthRaw;
    const defenderFleetBonus = calculateFleetBonus(defWarships);
    const defenderStrength = calculateShipStrength(defWarships, defShips, defenderCommander) * (1 + defenderFleetBonus);
    const defenderHP        = calculateShipHP(defWarships, defShips, defenderCommander) * (1 + defenderFleetBonus);

    // PHASE 4: Sieger
    const attackerWins = attackerStrength >= defenderHP;
    report.attackerWins = attackerWins;

    // PHASE 5: Verluste
    const strengthRatio = attackerStrength / Math.max(defenderStrength, 1);
    const loserLoss  = LOSER_LOSS_MIN + Math.random() * (LOSER_LOSS_MAX - LOSER_LOSS_MIN);
    const winnerLoss = calculateWinnerLoss(strengthRatio);
    const attackerLossPercent = attackerWins ? winnerLoss : loserLoss;
    const defenderLossPercent = attackerWins ? loserLoss : winnerLoss;

    const attackerShipsBefore    = attackerFleet.ships || [0,0,0,0,0,0];
    const attackerAfterWarships  = applyLosses(attackerFleet.warships, attackerLossPercent);
    const attackerAfterShips     = applyLosses(attackerShipsBefore, attackerLossPercent);
    const defenderAfterWarships  = applyLosses(defWarships, defenderLossPercent);
    const defenderAfterShips     = applyLosses(defShips, defenderLossPercent);

    const attackerParticipant = buildParticipant(attackerCommander, attackerFleet.fleetId, true, false, false,
        attackerFleet.warships, attackerShipsBefore, attackerAfterWarships, attackerAfterShips,
        attackerFleetBonus, 'Stärke');
    report.attackers.push(attackerParticipant);
    report.totalAttackerShips += attackerParticipant.totalShipsBefore;

    const defenderParticipant = buildParticipant(defenderCommander, null, false, false, true,
        defWarships, defShips, defenderAfterWarships, defenderAfterShips,
        defenderFleetBonus, 'HP');
    defenderParticipant.commanderId   = report.planetOwnerId;
    defenderParticipant.commanderName = report.planetOwnerName;
    report.defenders.push(defenderParticipant);
    report.totalDefenderShips += defenderParticipant.totalShipsBefore;

    // PHASE 6: Beute (nur bei Angreifer-Sieg, nur wenn Verteidiger-Planet bekannt)
    let lootedRessources = [0,0,0,0,0];
    if (attackerWins && defenderPlanet) {
        const ironReserve = (defenderPlanet.buildings[0] || 0) * IRON_RESERVE_PER_LEVEL;
        let totalCargo = 0;
        for (const n of attackerShipsBefore) totalCargo += (n || 0) * 1000; // Cargo-Platzhalter je Zivilschiff
        for (const n of attackerFleet.warships) totalCargo += (n || 0) * 100;

        const lootOrder = [2, 1, 3];
        let remaining = totalCargo;
        for (const idx of lootOrder) {
            if (remaining <= 0) break;
            const available = Math.max(0, (defenderPlanet.ressources[idx] || 0) - ironReserve);
            const taken = Math.min(available, remaining);
            if (taken > 0) {
                defenderPlanet.ressources[idx] -= taken;
                report.loot[idx] = taken;
                report.totalLootValue += taken;
                remaining -= taken;
                lootedRessources[idx] = taken;
            }
        }
    }

    // PHASE 7: Recycling (geht an den Verteidiger-Planeten, nur wenn bekannt)
    if (defenderPlanet) {
        const recyclingBonus = RECYCLING_BASE + ((defenderCommander?.recycling || 0) * 0.01);
        let totalRecycled = 0;
        for (let i = 0; i < 10; i++) {
            const lostAttacker = Math.max(0, (attackerFleet.warships[i] || 0) - attackerAfterWarships[i]);
            const lostDefender = Math.max(0, (defWarships[i] || 0) - defenderAfterWarships[i]);
            const lost = lostAttacker + lostDefender;
            if (lost <= 0) continue;
            const buildCost = SHIP_BUILD_COST[i] || 1000;
            totalRecycled += Math.floor(lost * buildCost * recyclingBonus);
        }
        if (totalRecycled > 0) {
            const perRess = Math.floor(totalRecycled / 4);
            for (let i = 0; i < 4; i++) {
                defenderPlanet.ressources[i] = (defenderPlanet.ressources[i] || 0) + perRess;
                report.recycling[i] = perRess;
            }
        }
    }

    // PHASE 8: Reparatur
    const attackerRepairBonus = REPAIR_BASE + ((attackerCommander?.reparatur || 0) * 0.01);
    for (let i = 0; i < 10; i++) {
        const losses = (attackerFleet.warships[i] || 0) - attackerAfterWarships[i];
        if (losses <= 0) continue;
        const repaired = Math.floor(losses * attackerRepairBonus);
        if (repaired > 0) {
            attackerAfterWarships[i] += repaired;
            attackerParticipant.warshipsRepaired[i] = repaired;
            attackerParticipant.totalRepaired += repaired;
        }
    }
    if (defenderPlanet) {
        const defRepairBonus = REPAIR_BASE + ((defenderCommander?.reparatur || 0) * 0.01);
        for (let i = 0; i < 10; i++) {
            const losses = (defWarships[i] || 0) - defenderAfterWarships[i];
            if (losses <= 0) continue;
            const repaired = Math.floor(losses * defRepairBonus);
            if (repaired > 0) {
                defenderAfterWarships[i] += repaired;
                defenderParticipant.warshipsRepaired[i] = repaired;
                defenderParticipant.totalRepaired += repaired;
            }
        }
    }

    // Verluste nach Reparatur neu berechnen (für korrekte Anzeige im Bericht)
    recalcParticipantLosses(attackerParticipant, attackerFleet.warships, attackerShipsBefore, attackerAfterWarships, attackerAfterShips);
    recalcParticipantLosses(defenderParticipant, defWarships, defShips, defenderAfterWarships, defenderAfterShips);
    report.totalAttackerLosses = attackerParticipant.totalLosses;
    report.totalDefenderLosses = defenderParticipant.totalLosses;

    // PHASE 9: Erfahrung (Ress05)
    const attackerExp = 10 + (attackerWins ? 10 : 0);
    report.ress05Attacker = attackerExp;
    if (defenderPlanet) {
        const defenderExp = 10 + (!attackerWins ? 10 : 0);
        defenderPlanet.ressources[4] = (defenderPlanet.ressources[4] || 0) + defenderExp;
        report.ress05Defender = defenderExp;
    }

    // Attacker-Erfahrung direkt auf dessen Heimatplanet gutschreiben
    if (attackerCommander.colonies && attackerCommander.colonies.length > 0) {
        const homeCoord = attackerCommander.colonies[0];
        const homeKey = `planet_${homeCoord.replace(/:/g, '_')}`;
        try {
            const homeData = await playfabServer('/Server/GetUserData', { PlayFabId: attackerPlayFabId, Keys: [homeKey] });
            if (homeData.Data?.[homeKey]) {
                const homePlanet = JSON.parse(homeData.Data[homeKey].Value);
                if (homePlanet.ressources && homePlanet.ressources.length > 4) {
                    homePlanet.ressources[4] = (homePlanet.ressources[4] || 0) + attackerExp;
                    await playfabServer('/Server/UpdateUserData', {
                        PlayFabId: attackerPlayFabId,
                        Data: { [homeKey]: JSON.stringify(homePlanet) },
                        Permission: 'Private'
                    });
                }
            }
        } catch (e) {
            log.push(`Erfahrung-Gutschrift Fehler: ${e.message}`);
        }
    }

    // Verteidiger-Planet + Commander speichern (falls bekannt)
    if (defenderPfid && defenderPlanetKey && defenderPlanet) {
        defenderPlanet.warships = defenderAfterWarships;
        defenderPlanet.ships    = defenderAfterShips;
        try {
            await playfabServer('/Server/UpdateUserData', {
                PlayFabId: defenderPfid,
                Data: { [defenderPlanetKey]: JSON.stringify(defenderPlanet) },
                Permission: 'Private'
            });
        } catch (e) {
            log.push(`Verteidiger-Planet speichern Fehler: ${e.message}`);
        }

        if (defenderCommander) {
            sendCombatMail(defenderCommander, report, false);
            try {
                await playfabServer('/Server/UpdateUserData', {
                    PlayFabId: defenderPfid,
                    Data: { 'commander_data': JSON.stringify(defenderCommander) },
                    Permission: 'Private'
                });
            } catch (e) {
                log.push(`Verteidiger-Commander speichern Fehler: ${e.message}`);
            }
        }
    }

    // Angreifer-Mail
    sendCombatMail(attackerCommander, report, true);

    log.push(`Kampf: ${attackerFleet.fleetId} | ${attackerWins ? 'Angreifer siegt' : 'Verteidiger siegt'} | Verluste ${report.totalAttackerLosses}/${report.totalDefenderLosses}`);

    // Rückflug-Flotte (mit Beute, Erfahrung wurde bereits direkt verbucht)
    return buildReturnFleet(attackerFleet, now, attackerAfterWarships, lootedRessources);
}

function buildReturnFleet(fleet, now, warshipsRemaining, lootRessources) {
    const flightTime = calculateFlightTime(fleet.destinationCoord, fleet.originCoord, fleet.engineLevel || 1, fleet.fuelFactor || 1);
    return {
        fleetId:          fleet.fleetId + '-R',
        commanderId:      fleet.commanderId,
        commanderName:    fleet.commanderName,
        originCoord:      fleet.destinationCoord,
        destinationCoord: fleet.originCoord,
        departureUtc:     now.toISOString(),
        arrivalUtc:       new Date(now.getTime() + flightTime * 1000).toISOString(),
        mission:          10,
        warships:         warshipsRemaining,
        ships:            fleet.ships || [0,0,0,0,0,0],
        ressources:       lootRessources || [0,0,0,0,0],
        isReturnFlight:   true,
        hasArrived:       false,
        engineLevel:      fleet.engineLevel || 1,
        fuelFactor:       fleet.fuelFactor  || 1
    };
}

// Kampfbericht-Mail inkl. vollständiger reportData (JSON) für
// CombatReportController.OpenReportFromMail() in Unity.
function sendCombatMail(commander, report, isAttackerMail) {
    if (!commander) return;
    const victory      = isAttackerMail ? report.attackerWins : !report.attackerWins;
    const ownLosses     = isAttackerMail ? report.totalAttackerLosses : report.totalDefenderLosses;
    const enemyLosses   = isAttackerMail ? report.totalDefenderLosses : report.totalAttackerLosses;
    const subject = `Kampfbericht: ${report.planetCoord}`;

    let body;
    if (report.shieldHeld) {
        body = `Das planetare Schild hat gehalten. Wir mussten uns zurückziehen.`;
    } else {
        body = `${victory ? 'Sieg' : 'Niederlage'} bei ${report.planetCoord}.\nEigene Verluste: ${ownLosses}\nFeindliche Verluste: ${enemyLosses}`;
    }

    if (!commander.inbox) commander.inbox = [];
    if (!commander.nextMailCounter) commander.nextMailCounter = 1;

    commander.inbox.push({
        mailId: `M-${commander.commanderId}-${commander.nextMailCounter++}`,
        category: 2, // Military
        subject,
        body,
        senderName: 'System',
        senderId: 0,
        isRead: false,
        isFavorite: false,
        timestamp: formatTimestamp(new Date()),
        reportId: report.reportId,
        reportData: JSON.stringify(report)
    });
}

// -------------------------------------------------------
// Rückflug landen
// -------------------------------------------------------
async function processReturn(playFabId, commander, fleet, log) {
    // Schiffe auf Heimatplanet gutschreiben
    const planetKey = `planet_${fleet.destinationCoord.replace(/:/g, '_')}`;
    try {
        const pData = await playfabServer('/Server/GetUserData', {
            PlayFabId: playFabId, Keys: [planetKey]
        });
        if (pData.Data?.[planetKey]) {
            const planet = JSON.parse(pData.Data[planetKey].Value);
            fleet.warships.forEach((n, i) => { planet.warships[i] = (planet.warships[i] || 0) + n; });
            fleet.ressources.forEach((n, i) => { planet.ressources[i] = (planet.ressources[i] || 0) + n; });
            await playfabServer('/Server/UpdateUserData', {
                PlayFabId: playFabId,
                Data: { [planetKey]: JSON.stringify(planet) },
                Permission: 'Private'
            });
        }
    } catch(e) {}

    sendMail(commander, 'Flotte zurückgekehrt',
        `Flotte ${fleet.fleetId} ist auf ${fleet.destinationCoord} gelandet.`, 1);

    log.push(`Rückflug gelandet: ${fleet.fleetId}`);
}

function calculateFlightTime(from, to, engineLevel = 1, fuelFactor = 1) {
    const f = from.split(':').map(Number);
    const t = to.split(':').map(Number);
    const sectorDist = Math.min(Math.abs(f[1]-t[1]), 4-Math.abs(f[1]-t[1]));
    const systemDist = Math.min(Math.abs(f[2]-t[2]), 12-Math.abs(f[2]-t[2]));
    const planetDist = Math.abs(f[3]-t[3]);
    let total = sectorDist * 45 + systemDist * 30 + planetDist * 10;
    if (total <= 0) total = 10;
    total = Math.max(total - (engineLevel - 1), 10);
    if (fuelFactor < 1 && fuelFactor > 0) total = total / fuelFactor;
    return total;
}

// Generische, nicht kampfbezogene Mail (z.B. "Flotte zurückgekehrt")
function sendMail(commander, subject, body, category) {
    if (!commander.inbox) commander.inbox = [];
    if (!commander.nextMailCounter) commander.nextMailCounter = 1;
    commander.inbox.push({
        mailId:    `M-${commander.commanderId}-${commander.nextMailCounter++}`,
        category,
        subject,
        body,
        senderName: 'System',
        senderId:   0,
        isRead:    false,
        isFavorite: false,
        timestamp: formatTimestamp(new Date())
    });
}

function applyResearch(commander, type, level) {
    const map = {
        0:'ress01',1:'ress02',2:'ress03',3:'ress04',4:'ress05',
        5:'weapon01',6:'weapon02',7:'weapon03',
        8:'shield01',9:'shield02',10:'shield03',
        11:'engine01',12:'engine02',13:'engine03',14:'engine04',
        15:'recycling',16:'reparatur',17:'terraforming',
        18:'verwaltung',19:'architektur',20:'ingenieurwesen',21:'wirtschaftslehre'
    };
    if (map[type]) commander[map[type]] = level;
}

async function processFleetArrival(playFabId, commander, fleet, now) {
    const mission = fleet.mission;
    if (mission === 3 || mission === 'Attack')
        return await resolveCombat(playFabId, commander, fleet, now, []);
    if (mission === 10 || mission === 'Return') {
        await processReturn(playFabId, commander, fleet, []);
        return null;
    }
    return null;
}

// -------------------------------------------------------
// Server starten
// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`VIRGO Server läuft auf Port ${PORT}`);
});
