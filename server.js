// ============================================================
//  VIRGO: Space Dominion — Game Server
//  Node.js Server für Render.com
//  Ersetzt PlayFab CloudScript für Spiellogik
//
//  ÄNDERUNG (Juli 2026):
//  /processFleet hat bisher die verarbeitete Flotte NIE aus
//  commander.activeFleets entfernt und eine neu erzeugte
//  Rückflug-Flotte NIE gespeichert. Dadurch:
//   - blieben "Geister-Flotten" (hasArrived=true) für immer
//     in activeFleets stehen
//   - gingen Rückflüge (Schiffe!) komplett verloren, sobald
//     der Spieler beim Ankommen der Angriffsflotte online war
//  /serverTick hatte das schon richtig gemacht (splice + push).
//  /processFleet macht es jetzt genauso.
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
        // Commander laden
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
                            const returnFleet = await processAttack(playFabId, commander, fleet, now, log);
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
// Hilfsfunktionen
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

// HINWEIS (nicht behoben, nur dokumentiert):
// defWarships ist hier immer [0,0,0,0,0,0,0,0,0,0] — die tatsächliche
// Verteidigung (NPC- oder Spieler-Schiffe auf dem Zielplaneten) wird
// aktuell NICHT eingelesen. Der Angreifer gewinnt dadurch praktisch
// immer. Das ist ein separates, noch offenes Balancing-/Feature-Thema
// (Verteidigung ist wohl schlicht noch nicht implementiert) und wurde
// hier bewusst NICHT mit angefasst, um den Rückflug-Fix nicht mit
// unabhängigen Änderungen zu vermischen.
async function processAttack(attackerPlayFabId, commander, fleet, now, log) {
    // Kampfberechnung
    const defWarships = [0,0,0,0,0,0,0,0,0,0];
    const shipStrength = [10, 25, 60, 120, 0, 0, 0, 0, 0, 0];
    const attackPower  = fleet.warships.reduce((sum, n, i) => sum + n * (shipStrength[i] || 0), 0);
    const defensePower = defWarships.reduce((sum, n, i) => sum + n * (shipStrength[i] || 0), 0);

    const total = attackPower + defensePower || 1;
    const attackerSurvival = Math.max(0.1, 1 - defensePower / total);
    const attackerRemaining = fleet.warships.map((n, i) =>
        Math.max(n > 0 ? 1 : 0, n - Math.floor(n * (1 - attackerSurvival)))
    );
    const attackerLosses = fleet.warships.map((n, i) => n - attackerRemaining[i]);
    const lossCount = attackerLosses.reduce((a, b) => a + b, 0);

    // Mail senden
    sendMail(commander,
        `Kampfbericht: ${fleet.destinationCoord}`,
        `Siegreicher Kampf. Verluste: ${lossCount} Schiffe.`,
        2);

    log.push(`Kampf: ${fleet.fleetId} | Sieg`);

    // Rückflug erstellen
    const flightTime = calculateFlightTime(fleet.destinationCoord, fleet.originCoord);
    return {
        fleetId:          fleet.fleetId + '-R',
        commanderId:      fleet.commanderId,
        commanderName:    fleet.commanderName,
        originCoord:      fleet.destinationCoord,
        destinationCoord: fleet.originCoord,
        departureUtc:     now.toISOString(),
        arrivalUtc:       new Date(now.getTime() + flightTime * 1000).toISOString(),
        mission:          10,
        warships:         attackerRemaining,
        ships:            fleet.ships || [0,0,0,0,0,0],
        ressources:       [0,0,0,0,0],
        isReturnFlight:   true,
        hasArrived:       false,
        engineLevel:      fleet.engineLevel || 1,
        fuelFactor:       fleet.fuelFactor  || 1
    };
}

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

function sendMail(commander, subject, body, category) {
    if (!commander.inbox) commander.inbox = [];
    if (!commander.nextMailCounter) commander.nextMailCounter = 1;
    const now = new Date();
    commander.inbox.push({
        mailId:    `M-${commander.commanderId}-${commander.nextMailCounter++}`,
        category,
        subject,
        body,
        senderName: 'System',
        senderId:   0,
        isRead:    false,
        isFavorite: false,
        timestamp: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}, ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
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
        return await processAttack(playFabId, commander, fleet, now, []);
    if (mission === 10 || mission === 'Return')
        await processReturn(playFabId, commander, fleet, []);
    return null;
}

// -------------------------------------------------------
// Server starten
// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`VIRGO Server läuft auf Port ${PORT}`);
});
