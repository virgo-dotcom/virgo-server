// ============================================================
//  VIRGO: Space Dominion — Game Server
//  Node.js Server für Render.com
//  Ersetzt PlayFab CloudScript für Spiellogik
//
//  ÄNDERUNG (Juli 2026) — drei Themen behoben:
//
//  1) /processFleet entfernt die verarbeitete Flotte jetzt wirklich
//     aus commander.activeFleets und speichert eine neu erzeugte
//     Rückflug-Flotte tatsächlich mit ab (wie /serverTick: splice + push).
//
//  2) Kampf ist jetzt eine vollständige Portierung der Formeln aus
//     CombatManager.cs: echte Verteidigung (liest den Zielplaneten über
//     den pfid-Besitzer-Lookup), planetares Schild, Waffen-/Schild-
//     Forschungsboni, Flottenbonus, Recycling, Reparatur, Erfahrung.
//
//  3) NEU: Kampfberichte werden nicht mehr in der Mail oder in PlayFab
//     Title Data gespeichert, sondern dauerhaft in einer eigenen
//     PostgreSQL-Datenbank (auf Render gehostet). Jeder Bericht ist
//     eine eigene Zeile -> kein Größenlimit, keine Race Conditions bei
//     gleichzeitigen Kämpfen (im Gegensatz zu einem einzelnen, geteilten
//     Title-Data-Blob). Mails tragen nur noch die reportId als Verweis,
//     nicht mehr den kompletten Bericht.
// ============================================================

const express = require('express');
const axios   = require('axios');
const { Pool } = require('pg');
const app     = express();

app.use(express.json());

// -------------------------------------------------------
// CORS — WICHTIG für WebGL-Builds!
// Der WebGL-Build läuft im Browser (auf itch.io), Anfragen an
// virgo-server.onrender.com sind also Cross-Origin-Requests. Ohne
// diese Header blockiert der Browser den Request stillschweigend,
// bevor er den Server überhaupt erreicht (im Unity-Editor tritt das
// NIE auf, da dort keine Browser-CORS-Regeln gelten — deshalb fiel
// es erst beim WebGL-Test auf).
// -------------------------------------------------------
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// PlayFab Konfiguration
const PLAYFAB_TITLE_ID  = '192413';
const PLAYFAB_SECRET    = process.env.PLAYFAB_SECRET_KEY;
const PLAYFAB_BASE_URL  = `https://${PLAYFAB_TITLE_ID}.playfabapi.com`;

// -------------------------------------------------------
// PostgreSQL Verbindung (Kampfberichte)
// DATABASE_URL wird als Environment Variable in Render gesetzt
// (Internal Database URL der Render-Postgres-Instanz)
// -------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS combat_reports (
                report_id TEXT PRIMARY KEY,
                planet_coord TEXT,
                attacker_commander_id INTEGER,
                defender_commander_id INTEGER,
                attacker_wins BOOLEAN,
                shield_held BOOLEAN,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                data JSONB NOT NULL
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_combat_reports_created_at ON combat_reports (created_at DESC);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_combat_reports_attacker ON combat_reports (attacker_commander_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_combat_reports_defender ON combat_reports (defender_commander_id);`);

        // Globale, garantiert eindeutige, fortlaufende Nummer für Bericht-IDs.
        // Postgres-Sequenzen sind atomar — auch wenn irgendwo im Spiel
        // gleichzeitig mehrere Kämpfe abgeschlossen werden, kann es NIE
        // zwei Berichte mit derselben Nummer geben (im Gegensatz zum alten
        // Millisekunden-Zeitstempel-Ansatz).
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS combat_report_seq;`);

        // NEU: eigene Sequenz für Mail-IDs. Grund: mailId wurde bisher aus
        // commander.nextMailCounter gebildet (im commander_data-JSON
        // gespeichert). Wenn zwei /processFleet-Aufrufe für denselben
        // Commander dicht hintereinander liefen, konnte der zweite Aufruf
        // noch den alten (nicht erhöhten) Zähler lesen, bevor der erste
        // seine Erhöhung fertig gespeichert hatte -> zwei Mails mit exakt
        // derselben mailId. Eine Postgres-Sequenz ist atomar und kann das
        // nicht mehr passieren lassen, egal wie viele Anfragen gleichzeitig
        // eintreffen.
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS mail_id_seq;`);

        // Sperre gegen doppelte Flottenverarbeitung. Egal WOHER ein doppelter
        // Aufruf für dieselbe Flotte kommt (Client-Doppelklick, zwei offene
        // Tabs, ein zusätzlicher /serverTick-Trigger, der zufällig zur
        // gleichen Zeit reinkommt wie der Client-Request) — nur der erste
        // Versuch, eine bestimmte fleetId hier einzutragen, gewinnt. Jeder
        // weitere Versuch scheitert an der PRIMARY KEY-Regel und bricht
        // sauber ab, statt den Kampf ein zweites Mal zu verarbeiten.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS processed_fleets (
                fleet_id TEXT PRIMARY KEY,
                processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_processed_fleets_time ON processed_fleets (processed_at);`);

        // NEU: Angriffs-Verfolgung ("Angriffs-Akte"). Protokolliert pro
        // Angriffs-Flotte JEDEN Schritt des Lebenszyklus, dauerhaft und
        // unabhängig davon, wer gerade eingeloggt ist (im Gegensatz zum
        // rein lokalen FleetDebugTracker im Client, der nur sieht, was in
        // der jeweils aktiven Unity-Sitzung passiert). Das ist die
        // Grundlage für den "Fehler melden"-Button im Debug-Fenster:
        // Egal welcher Schritt hängen bleibt (Warnung, Kampf, Rückflug),
        // hier steht es mit Zeitstempel drin.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS attack_traces (
                fleet_id TEXT PRIMARY KEY,
                attacker_commander_id INTEGER,
                defender_commander_id INTEGER,
                origin_coord TEXT,
                destination_coord TEXT,

                launched_at TIMESTAMPTZ,
                expected_arrival_utc TIMESTAMPTZ,

                notify_attack_at TIMESTAMPTZ,
                notify_attack_success BOOLEAN,

                combat_started_at TIMESTAMPTZ,
                combat_processed_at TIMESTAMPTZ,
                combat_success BOOLEAN,
                combat_report_id TEXT,
                shield_held BOOLEAN,

                return_fleet_id TEXT,
                return_processed_at TIMESTAMPTZ,
                return_success BOOLEAN,

                last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_attack_traces_attacker ON attack_traces (attacker_commander_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_attack_traces_defender ON attack_traces (defender_commander_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_attack_traces_updated ON attack_traces (last_updated_at DESC);`);

        console.log('[DB] Tabelle combat_reports + Sequenz + Flotten-Sperre + Angriffs-Verfolgung bereit.');
    } catch (e) {
        console.error('[DB] Init fehlgeschlagen (DATABASE_URL gesetzt?):', e.message);
    }
}
initDatabase();

// Versucht, eine Flotte exklusiv "zu beanspruchen", bevor sie verarbeitet
// wird. Gibt true zurück, wenn dieser Aufruf die Flotte verarbeiten darf;
// false, wenn ein anderer Prozess sie bereits (zeitgleich) übernommen hat.
async function claimFleetForProcessing(fleetId) {
    try {
        await pool.query('INSERT INTO processed_fleets (fleet_id) VALUES ($1)', [fleetId]);
        return true;
    } catch (e) {
        // Unique-Constraint-Verletzung = bereits vergeben
        return false;
    }
}

// -------------------------------------------------------
// Angriffs-Verfolgung: Zeile anlegen (falls noch nicht vorhanden) und die
// übergebenen Felder aktualisieren. "fields" ist ein einfaches Objekt wie
// { combat_processed_at: new Date(), combat_success: true }. Die
// Feldnamen kommen ausschließlich aus unserem eigenen Code (nie aus
// Nutzereingaben) — SQL-Injection ist dadurch kein Thema.
// -------------------------------------------------------
async function upsertAttackTrace(fleetId, fields) {
    try {
        await pool.query(
            'INSERT INTO attack_traces (fleet_id) VALUES ($1) ON CONFLICT (fleet_id) DO NOTHING',
            [fleetId]
        );

        const keys = Object.keys(fields || {});
        if (keys.length === 0) return;

        const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const values = keys.map(k => fields[k]);

        await pool.query(
            `UPDATE attack_traces SET ${setClauses}, last_updated_at = now() WHERE fleet_id = $1`,
            [fleetId, ...values]
        );
    } catch (e) {
        console.error(`[DB] upsertAttackTrace Fehler (${fleetId}):`, e.message);
    }
}

async function getAttackTrace(fleetId) {
    try {
        const result = await pool.query('SELECT * FROM attack_traces WHERE fleet_id = $1', [fleetId]);
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (e) {
        console.error('[DB] getAttackTrace Fehler:', e.message);
        return null;
    }
}

async function getRecentAttackTraces(commanderId, limit) {
    try {
        const result = await pool.query(
            `SELECT * FROM attack_traces
             WHERE attacker_commander_id = $1 OR defender_commander_id = $1
             ORDER BY last_updated_at DESC LIMIT $2`,
            [commanderId, limit]
        );
        return result.rows;
    } catch (e) {
        console.error('[DB] getRecentAttackTraces Fehler:', e.message);
        return [];
    }
}

// Nächste fortlaufende Bericht-Nummer atomar aus der Datenbank holen
async function getNextReportSeq() {
    const result = await pool.query("SELECT nextval('combat_report_seq') AS seq");
    return result.rows[0].seq;
}

// Nächste fortlaufende Mail-Nummer atomar aus der Datenbank holen
async function getNextMailSeq() {
    const result = await pool.query("SELECT nextval('mail_id_seq') AS seq");
    return result.rows[0].seq;
}

async function saveReportToDatabase(report) {
    try {
        const attackerId = report.attackers && report.attackers[0] ? report.attackers[0].commanderId : null;
        await pool.query(
            `INSERT INTO combat_reports
                (report_id, planet_coord, attacker_commander_id, defender_commander_id, attacker_wins, shield_held, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (report_id) DO NOTHING`,
            [report.reportId, report.planetCoord, attackerId, report.planetOwnerId,
             report.attackerWins, report.shieldHeld, JSON.stringify(report)]
        );
    } catch (e) {
        console.error('[DB] Bericht speichern fehlgeschlagen:', e.message);
    }
}

async function getReportById(reportId) {
    try {
        const result = await pool.query('SELECT data FROM combat_reports WHERE report_id = $1', [reportId]);
        if (result.rows.length === 0) return null;
        return result.rows[0].data; // JSONB kommt von pg bereits als Objekt zurück
    } catch (e) {
        console.error('[DB] Bericht laden fehlgeschlagen:', e.message);
        return null;
    }
}

// -------------------------------------------------------
// Health Check
// -------------------------------------------------------
app.get('/', (req, res) => {
    res.json({ status: 'VIRGO Server läuft', time: new Date().toISOString() });
});

// -------------------------------------------------------
// Kampfbericht abrufen (für Unity: Mail/Chat "Bericht öffnen")
// -------------------------------------------------------
app.get('/report/:reportId', async (req, res) => {
    const report = await getReportById(req.params.reportId);
    if (!report) return res.status(404).json({ success: false, error: 'Bericht nicht gefunden' });
    res.json({ success: true, report });
});

// -------------------------------------------------------
// Angriffs-Akte abrufen — für den "Fehler melden"-Button im Client.
// Zeigt den kompletten, serverseitig protokollierten Lebenszyklus einer
// einzelnen Angriffs-Flotte (Warnung/Kampf/Rückflug), unabhängig davon,
// wer gerade eingeloggt ist.
// -------------------------------------------------------
app.get('/attackTrace/:fleetId', async (req, res) => {
    const trace = await getAttackTrace(req.params.fleetId);
    if (!trace) return res.status(404).json({ success: false, error: 'Keine Akte gefunden' });
    res.json({ success: true, trace });
});

// Letzte Angriffs-Akten eines Commanders (als Angreifer ODER Verteidiger)
// — z.B. für eine Übersicht "meine letzten Angriffe/Verteidigungen" im
// Debug-Fenster.
app.get('/attackTraces/recent', async (req, res) => {
    const commanderId = parseInt(req.query.commanderId, 10);
    if (!commanderId) return res.status(400).json({ success: false, error: 'commanderId erforderlich' });
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const traces = await getRecentAttackTraces(commanderId, limit);
    res.json({ success: true, traces });
});

// -------------------------------------------------------
// Kampfbericht speichern (für CombatManager.cs lokale Vorschau-Kämpfe;
// serverseitige Kämpfe aus resolveCombat() speichern direkt über
// saveReportToDatabase(), ohne den Umweg über HTTP)
// -------------------------------------------------------
app.post('/saveReport', async (req, res) => {
    const report = req.body;
    if (!report || !report.reportId)
        return res.status(400).json({ success: false, error: 'Ungueltiger Bericht' });
    await saveReportToDatabase(report);
    res.json({ success: true });
});

// -------------------------------------------------------
// Angriffs-Warnung an den Verteidiger schicken — wird vom ANGREIFER-Client
// direkt nach dem Losschicken einer Attack-Flotte aufgerufen.
//
// WICHTIG: Das kann NICHT der Client selbst erledigen (er hat keinen
// Zugriff auf den PlayFab-Account eines anderen Spielers) — deshalb läuft
// das hier über den Server, genau wie beim Kampfbericht: pfid-Lookup über
// die öffentlichen Systemdaten, dann direkter Schreibzugriff mit dem
// Secret Key.
//
// Bei NPCs oder unbekannten Zielen passiert einfach nichts (kein Fehler),
// da NPCs keinen echten Account haben.
// -------------------------------------------------------
app.post('/notifyAttack', async (req, res) => {
    const { fleetId, attackerCommanderId, attackerName, originCoord, destinationCoord, arrivalUtc } = req.body;
    if (!fleetId || !attackerName || !originCoord || !destinationCoord || !arrivalUtc)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        const ownerInfo = await getPlanetOwnerInfo(destinationCoord);
        const isRealPlayerDefender = !!(ownerInfo && ownerInfo.pfid && ownerInfo.ownerCommanderId >= 1000000);

        // Angriffs-Akte anlegen — passiert IMMER, unabhängig davon, ob der
        // Verteidiger ein echter Spieler ist oder nicht, damit die
        // komplette Kette (Start → Warnung → Kampf → Rückflug) für JEDEN
        // Angriff nachvollziehbar bleibt.
        await upsertAttackTrace(fleetId, {
            attacker_commander_id: attackerCommanderId || null,
            defender_commander_id: ownerInfo ? ownerInfo.ownerCommanderId : null,
            origin_coord: originCoord,
            destination_coord: destinationCoord,
            launched_at: new Date(),
            expected_arrival_utc: new Date(arrivalUtc),
            notify_attack_at: new Date(),
            notify_attack_success: isRealPlayerDefender
        });

        if (!isRealPlayerDefender) {
            // NPC oder unbekanntes Ziel -> keine Mail nötig, aber kein Fehler
            return res.json({ success: true, notified: false });
        }

        const defenderData = await playfabServer('/Server/GetUserData', {
            PlayFabId: ownerInfo.pfid,
            Keys: ['commander_data']
        });
        if (!defenderData.Data?.['commander_data'])
            return res.json({ success: true, notified: false });

        const defenderCommander = JSON.parse(defenderData.Data['commander_data'].Value);

        const arrivalDate = new Date(arrivalUtc);
        const remainingSeconds = Math.max(0, Math.round((arrivalDate - new Date()) / 1000));

        if (!defenderCommander.inbox) defenderCommander.inbox = [];
        const mailSeq = await getNextMailSeq();
        defenderCommander.inbox.push({
            mailId: `M-${defenderCommander.commanderId}-${mailSeq}`,
            category: 2, // Military
            subject: `Angriff auf ${destinationCoord}`,
            body: `Achtung, Sie werden angegriffen von ${attackerName}. Die Angriffsflotte n\u00e4hert sich von ${originCoord}, Ankunft in ${formatDurationText(remainingSeconds)}, um ${formatTimestamp(arrivalDate)}.`,
            senderName: 'Milit\u00e4rkommando',
            senderId: 0,
            isRead: false,
            isFavorite: false,
            timestamp: formatTimestamp(new Date()),
            reportId: '',
            // NEU: markiert diese Mail als aktive Angriffs-Warnung, solange
            // die Flotte noch nicht angekommen ist. Das Dashboard des
            // Verteidigers nutzt dieses Feld, um eine fette, rote Warnzeile
            // anzuzeigen, bis der Angriff tats\u00e4chlich stattgefunden hat.
            attackArrivalUtc: arrivalUtc,
            attackTargetCoord: destinationCoord
        });

        await playfabServer('/Server/UpdateUserData', {
            PlayFabId: ownerInfo.pfid,
            Data: { 'commander_data': JSON.stringify(defenderCommander) },
            Permission: 'Private'
        });

        res.json({ success: true, notified: true });
    } catch (error) {
        console.error('[Server] notifyAttack Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// Admin: letzte Kampfberichte stichprobenartig einsehen
// Aufruf im Browser: https://virgo-server.onrender.com/admin/reports?key=DEIN_ADMIN_KEY
// Optional: &limit=20 (max 200)
// -------------------------------------------------------
app.get('/admin/reports', async (req, res) => {
    if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, error: 'Nicht autorisiert' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    try {
        const result = await pool.query(
            'SELECT data FROM combat_reports ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        res.json({ success: true, count: result.rows.length, reports: result.rows.map(r => r.data) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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
        // WICHTIG: nach fleetId filtern statt nur den einen Index zu
        // entfernen — falls durch einen alten Bug dieselbe fleetId mehrfach
        // in der Liste steht, werden hier ALLE Kopien auf einmal entfernt
        // (sonst bleibt ein "Zwilling" für immer als Zombie-Eintrag stehen).
        if (fleet.hasArrived) {
            commander.activeFleets = commander.activeFleets.filter(f => f.fleetId !== fleet.fleetId);
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

        // Race-Guard: sicherstellen, dass diese Flotte nicht GERADE JETZT
        // von einem anderen Aufruf verarbeitet wird (z.B. zeitgleicher
        // /serverTick, doppelter Client-Request). Nur wer die Flotte
        // erfolgreich "beansprucht", macht mit der Verarbeitung weiter.
        const claimed = await claimFleetForProcessing(fleet.fleetId);
        if (!claimed) {
            return res.json({ success: true, message: 'Flotte wird bereits verarbeitet (Duplikat verhindert)' });
        }

        // Flotte verarbeiten (Kampf oder Rückflug-Landung)
        const returnFleet = await processFleetArrival(playFabId, commander, fleet, now);

        // WICHTIG: alte Flotte(n) aus der Liste entfernen (alle mit
        // gleicher fleetId, siehe Kommentar oben), ggf. neue
        // Rückflug-Flotte hinzufügen (wie in /serverTick)
        commander.activeFleets = commander.activeFleets.filter(f => f.fleetId !== fleet.fleetId);
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
        // NEU: Fehlschlag in der Angriffs-Akte vermerken, damit der
        // "Fehler melden"-Button im Client genau diesen Zeitpunkt und
        // diese Fehlermeldung anzeigen kann, statt dass die Flotte einfach
        // spurlos verschwindet.
        await upsertAttackTrace(fleetId, {
            combat_processed_at: new Date(),
            combat_success: false
        });
        res.status(500).json({ error: error.message });
    }
});

// -------------------------------------------------------
// Server Tick (alle 5 Minuten von außen aufrufen)
// -------------------------------------------------------
// serverTickHandler ist als eigene Funktion definiert, damit sie sowohl per
// POST (z.B. für manuelle/Debug-Aufrufe) als auch per GET (für kostenlose
// externe Scheduler wie cron-job.org, die meist nur GET-Pings können)
// erreichbar ist. OHNE einen automatischen, regelmäßigen Aufruf verarbeitet
// NIEMAND Flotten, deren Besitzer bei Ankunft offline ist — das war die
// eigentliche Ursache hinter den "Zombie-Flotten".
async function serverTickHandler(req, res) {
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
                    const idsToRemove = new Set();

                    for (let f = 0; f < commander.activeFleets.length; f++) {
                        const fleet = commander.activeFleets[f];
                        if (!fleet || !fleet.arrivalUtc) continue;
                        if (fleet.hasArrived) { idsToRemove.add(fleet.fleetId); continue; }
                        if (new Date(fleet.arrivalUtc) > now) continue;

                        // Race-Guard: wird diese Flotte gerade zeitgleich woanders
                        // verarbeitet (z.B. Client-Request über /processFleet)?
                        // Falls ja, hier überspringen statt doppelt zu verarbeiten —
                        // der andere Prozess kümmert sich darum.
                        const claimed = await claimFleetForProcessing(fleet.fleetId);
                        if (!claimed) continue;

                        commander.activeFleets[f].hasArrived = true;
                        const missionNum = fleet.mission;

                        if (missionNum === 3 || missionNum === 'Attack') {
                            const returnFleet = await resolveCombat(playFabId, commander, fleet, now, log);
                            if (returnFleet) returnFleets.push(returnFleet);
                        } else if (missionNum === 10 || missionNum === 'Return') {
                            await processReturn(playFabId, commander, fleet, log);
                        }

                        idsToRemove.add(fleet.fleetId);
                        changed = true;
                    }

                    // Verarbeitete entfernen — nach fleetId statt nach Index,
                    // damit evtl. Duplikat-Zwillinge (gleiche fleetId mehrfach
                    // in der Liste, durch alte Bugs) gemeinsam mit entfernt werden.
                    if (idsToRemove.size > 0)
                        commander.activeFleets = commander.activeFleets.filter(f => !idsToRemove.has(f.fleetId));

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
}

app.post('/serverTick', serverTickHandler);
app.get('/serverTick', serverTickHandler);

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

function sumArray(arr) {
    return (arr || []).reduce((a, b) => a + (b || 0), 0);
}

// ---------------------------------------------------------------
// FLOTTENBONUS-EINSTELLUNGEN (Kampf-Balancing)
// Geometrische Kette: WS04 -> WS03 -> WS02 -> WS01
// Jede Stufe braucht mindestens 1 Schiff der Stufe darüber, um
// überhaupt zu zählen (kein WS04 = kompletter Bonus = 0%).
// Optimale Mischung für den vollen Bonus: 1×WS04, 2×WS03, 4×WS02, 8×WS01.
// ---------------------------------------------------------------
const FLEET_BONUS_PER_TIER      = 0.10;  // Bonus-Anteil pro Stufe (4 Stufen × 10% = 40% max)
const FLEET_BONUS_MAX           = 0.40;  // Gesamt-Obergrenze
const FLEET_BONUS_COVERAGE_RATIO = 2;    // Wie viele Schiffe der Stufe darunter 1 Schiff "deckt"

// Flottenbonus — geometrische Kette WS04 -> WS03 -> WS02 -> WS01
function calculateFleetBonus(warships) {
    const ws04 = warships[3] || 0;
    const ws03 = warships[2] || 0;
    const ws02 = warships[1] || 0;
    const ws01 = warships[0] || 0;

    const cap03 = ws04 * FLEET_BONUS_COVERAGE_RATIO;
    const cap02 = Math.min(ws03, cap03) * FLEET_BONUS_COVERAGE_RATIO;
    const cap01 = Math.min(ws02, cap02) * FLEET_BONUS_COVERAGE_RATIO;

    const eff03 = Math.min(ws03, cap03);
    const eff02 = Math.min(ws02, cap02);
    const eff01 = Math.min(ws01, cap01);

    const b04 = ws04 > 0 ? FLEET_BONUS_PER_TIER : 0;
    const b03 = cap03 > 0 ? FLEET_BONUS_PER_TIER * (eff03 / cap03) : 0;
    const b02 = cap02 > 0 ? FLEET_BONUS_PER_TIER * (eff02 / cap02) : 0;
    const b01 = cap01 > 0 ? FLEET_BONUS_PER_TIER * (eff01 / cap01) : 0;

    return Math.min(b04 + b03 + b02 + b01, FLEET_BONUS_MAX);
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

// WICHTIG: Der Render-Server läuft in UTC, nicht in deutscher Zeit.
// date.getHours() etc. würden also die Serverzeit zeigen (im Sommer
// 2 Stunden, im Winter 1 Stunde hinter der deutschen Zeit). Über
// Intl.DateTimeFormat mit Zeitzone "Europe/Berlin" wird das korrekt
// umgerechnet — inklusive automatischer Sommer-/Winterzeit-Umstellung,
// die sich nicht mehr von Hand nachpflegen muss.
function getBerlinParts(date) {
    const parts = new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return {
        year: get('year'), month: get('month'), day: get('day'),
        hour: get('hour'), minute: get('minute'), second: get('second')
    };
}

// Restzeit als lesbaren Text formatieren, z.B. "1d 03:12:05" oder "00:04:32"
function formatDurationText(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

function formatTimestamp(date) {
    const p = getBerlinParts(date);
    return `${p.day}.${p.month}. ${p.hour}:${p.minute}:${p.second}`;
}

// Datum als YYYYMMDD (für die Bericht-ID), ebenfalls in deutscher Zeit
function formatDateForId(date) {
    const p = getBerlinParts(date);
    return `${p.year}${p.month}${p.day}`;
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
            planetName: entry.pname || '',
            pfid: entry.pfid || null,
            hqLevel: entry.hq || 0
        };
    } catch (e) {
        return null;
    }
}

// =========================================================
// KAMPF AUFLÖSEN
// =========================================================
async function resolveCombat(attackerPlayFabId, attackerCommander, attackerFleet, now, log = []) {
    const destCoord = attackerFleet.destinationCoord;
    const ownerInfo = await getPlanetOwnerInfo(destCoord);

    // NEU: Angriffs-Akte — Kampfbeginn vermerken
    await upsertAttackTrace(attackerFleet.fleetId, { combat_started_at: now });

    // FIX: Commander-IDs echter Spieler starten bei 1.000.000 (7-stellig).
    // NPCs liegen im Bereich 900.001-999.999. Die alte Bedingung
    // "< 900000" schloss dadurch versehentlich JEDEN echten Spieler aus
    // (1.000.000 ist nie kleiner als 900.000!) — der Verteidiger-Datenabruf
    // lief dadurch nie, egal ob pfid vorhanden war oder nicht. Das war die
    // eigentliche Ursache für "Verteidiger: 0 Schiffe" bei allen PvP-Kämpfen.
    const isRealPlayerDefender = !!(ownerInfo && ownerInfo.pfid && ownerInfo.ownerCommanderId >= 1000000);

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

    // Neue Bericht-ID: {planetOwnerId}-{Datum}-{fortlaufende Sequenz-Nummer}
    // Die Sequenz-Nummer kommt atomar aus Postgres — dadurch garantiert
    // eindeutig, selbst wenn irgendwo im Spiel gleichzeitig andere Kämpfe
    // abgeschlossen werden (kein Millisekunden-Kollisionsrisiko mehr).
    const reportOwnerId = ownerInfo ? ownerInfo.ownerCommanderId : 0;
    const reportSeq = await getNextReportSeq();

    const report = {
        reportId: `CR-${reportOwnerId}-${formatDateForId(now)}-${reportSeq}`,
        timestamp: formatTimestamp(now),
        unixTimestamp: Math.floor(now.getTime() / 1000),
        planetCoord: destCoord,
        planetOwnerId: ownerInfo ? ownerInfo.ownerCommanderId : -1,
        planetOwnerName: ownerInfo ? ownerInfo.ownerName : 'Unbekannt',
        planetName: ownerInfo && ownerInfo.planetName ? ownerInfo.planetName : '',
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
        attackerStrengthVsShield: 0,
        // NEU: Platzhalter, bis die Schild-Mechanik wirklich fertig ist.
        // Das Gebäude existiert schon, die Kampf-Funktion aber noch nicht —
        // Phase 1 wird deshalb aktuell IMMER übersprungen. Dieses Feld
        // sorgt dafür, dass Spieletester im Bericht trotzdem sehen, dass
        // ein Schild-System geplant ist, nur eben noch nicht aktiv.
        shieldImplemented: false,
        // NEU: Sichtbare Gesamt-Bonuswerte im Bericht — OHNE zu verraten,
        // wodurch sie zustande kommen (bewusst kein Hinweis auf die
        // Flottenzusammensetzung im Bericht).
        attackerBonusPercent: 0,
        defenderBonusPercent: 0
    };

    const attackerFleetBonus  = calculateFleetBonus(attackerFleet.warships);
    const attackerStrengthRaw = calculateShipStrength(attackerFleet.warships, attackerFleet.ships, attackerCommander)
                                * (1 + attackerFleetBonus);
    report.attackerBonusPercent = Math.round(attackerFleetBonus * 1000) / 10; // z.B. 27.5

    // PHASE 1: Planetares Schild — AKTUELL DEAKTIVIERT.
    // Die Gebäude-Stufe (Building10) existiert bereits auf den Planeten,
    // aber die eigentliche Schild-Mechanik ist noch nicht fertig entwickelt
    // (Balancing/Regeln noch nicht final). Bis dahin wird dieser Schritt
    // immer übersprungen, egal welche Gebäude-Stufe der Verteidiger hat —
    // siehe report.shieldImplemented (oben) für die Platzhalter-Anzeige
    // im Kampfbericht.
    if (false) {
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

            await saveReportToDatabase(report);
            await sendCombatMail(attackerCommander, report, true);
            if (defenderPfid && defenderCommander) {
                await sendCombatMail(defenderCommander, report, false);
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
    report.defenderBonusPercent = Math.round(defenderFleetBonus * 1000) / 10;
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
            await sendCombatMail(defenderCommander, report, false);
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

    // Bericht dauerhaft in der Datenbank speichern (eigene Zeile,
    // unabhängig von Mails/PlayFab) + Angreifer-Mail
    await saveReportToDatabase(report);
    await sendCombatMail(attackerCommander, report, true);

    log.push(`Kampf: ${attackerFleet.fleetId} | ${attackerWins ? 'Angreifer siegt' : 'Verteidiger siegt'} | Verluste ${report.totalAttackerLosses}/${report.totalDefenderLosses}`);

    // Rückflug-Flotte (mit Beute, Erfahrung wurde bereits direkt verbucht)
    const finalReturnFleet = buildReturnFleet(attackerFleet, now, attackerAfterWarships, lootedRessources);

    // NEU: Angriffs-Akte — Kampf abgeschlossen, Rückflug-Flotte erzeugt
    await upsertAttackTrace(attackerFleet.fleetId, {
        combat_processed_at: new Date(),
        combat_success: true,
        combat_report_id: report.reportId,
        shield_held: false,
        return_fleet_id: finalReturnFleet.fleetId
    });

    return finalReturnFleet;
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

// Kampfbericht-Mail — trägt jetzt NUR NOCH die reportId als Verweis,
// nicht mehr den kompletten Bericht (der lebt jetzt dauerhaft in der DB).
async function sendCombatMail(commander, report, isAttackerMail) {
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

    // WICHTIG: mailId kommt jetzt aus der atomaren Postgres-Sequenz
    // (mail_id_seq), NICHT mehr aus commander.nextMailCounter. Der alte
    // Zähler lebte im commander_data-JSON und war anfällig für Race
    // Conditions bei dicht aufeinanderfolgenden Aufrufen (siehe Kommentar
    // bei der Sequenz-Erstellung in initDatabase).
    const mailSeq = await getNextMailSeq();

    commander.inbox.push({
        mailId: `M-${commander.commanderId}-${mailSeq}`,
        category: 2, // Military
        subject,
        body,
        senderName: 'System',
        senderId: 0,
        isRead: false,
        isFavorite: false,
        timestamp: formatTimestamp(new Date()),
        reportId: report.reportId
    });
}

// -------------------------------------------------------
// Rückflug landen
// -------------------------------------------------------
async function processReturn(playFabId, commander, fleet, log) {
    // Schiffe auf Heimatplanet gutschreiben
    const planetKey = `planet_${fleet.destinationCoord.replace(/:/g, '_')}`;
    let creditSuccess = false;
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
            creditSuccess = true;
        }
    } catch(e) {}

    await sendMail(commander, 'Flotte zurückgekehrt',
        `Flotte ${fleet.fleetId} ist auf ${fleet.destinationCoord} gelandet.`, 1);

    log.push(`Rückflug gelandet: ${fleet.fleetId}`);

    // NEU: Angriffs-Akte abschließen. fleet.fleetId ist hier die
    // Rückflug-ID ("F-...-R") — die Akte ist aber unter der ursprünglichen
    // Angriffs-fleetId (ohne "-R") gespeichert.
    const baseFleetId = fleet.fleetId.endsWith('-R')
        ? fleet.fleetId.slice(0, -2)
        : fleet.fleetId;
    await upsertAttackTrace(baseFleetId, {
        return_processed_at: new Date(),
        return_success: creditSuccess
    });
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
async function sendMail(commander, subject, body, category) {
    if (!commander.inbox) commander.inbox = [];
    const mailSeq = await getNextMailSeq();
    commander.inbox.push({
        mailId:    `M-${commander.commanderId}-${mailSeq}`,
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
