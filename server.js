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
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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

        // -------------------------------------------------------
        // Entwickler-ToDo-Liste ("Devlog") — im Spiel für alle Spieler
        // LESBAR (öffentliche Roadmap), aber nur im Admin-Modus
        // bearbeitbar/löschbar. Läuft komplett unabhängig vom restlichen
        // Spielgeschehen, rein zur eigenen Aufgabenverwaltung.
        // -------------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dev_todos (
                id SERIAL PRIMARY KEY,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_dev_todos_status ON dev_todos (status, created_at DESC);`);

        // -------------------------------------------------------
        // "Ankündigungen"-Kanal im Chat-Fenster — läuft über unseren
        // eigenen Server statt über PlayFab CloudScript, weil bestehende
        // Nachrichten nachträglich änderbar sein müssen (Erledigt-Häkchen,
        // für alle Spieler sichtbar). Nur TheVirgoDominion (Commander-ID
        // 1000000) darf posten und das Häkchen setzen/entfernen.
        // -------------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                sender_commander_id INTEGER NOT NULL,
                sender_name TEXT NOT NULL,
                sender_avatar_index INTEGER NOT NULL DEFAULT 0,
                text TEXT NOT NULL,
                is_done BOOLEAN NOT NULL DEFAULT false,
                done_timestamp TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements (created_at DESC);`);

        // Absicherung: falls "announcements" schon VOR der Einführung von
        // sender_avatar_index angelegt wurde, trägt CREATE TABLE IF NOT
        // EXISTS die neue Spalte NICHT automatisch nach (die Anweisung
        // wird bei bereits existierender Tabelle komplett übersprungen).
        // ALTER TABLE ... ADD COLUMN IF NOT EXISTS holt das gezielt nach.
        await pool.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS sender_avatar_index INTEGER NOT NULL DEFAULT 0;`);

        // -------------------------------------------------------
        // "TheVirgoDominion"-Kanal im Chat-Fenster — läuft (genau wie
        // "Ankündigungen") über unseren eigenen Server statt über PlayFab
        // CloudScript. Grund: Die bestehende CloudScript-Funktion kennt
        // vermutlich nur die ursprünglichen 5 Kanäle — neue Nachrichten im
        // neuen Kanal wurden zwar lokal sofort angezeigt, aber nie
        // dauerhaft gespeichert (verschwanden nach Login). Kein
        // Erledigt-Häkchen nötig, deshalb einfacher als "announcements".
        // -------------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS virgodom_messages (
                id SERIAL PRIMARY KEY,
                sender_commander_id INTEGER NOT NULL,
                sender_name TEXT NOT NULL,
                sender_avatar_index INTEGER NOT NULL DEFAULT 0,
                text TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_virgodom_messages_created_at ON virgodom_messages (created_at DESC);`);

        // =========================================================
        // ALLIANZEN & BEZIEHUNGEN (RelationshipManager-Kern)
        // Läuft komplett über unseren eigenen Server statt PlayFab —
        // mehrere Accounts verändern hier gemeinsam denselben Zustand
        // (Beitritt, Unterschrift, Kriegserklärung), das lässt sich in
        // PlayFabs Datenmodell nicht sauber/durchsuchbar abbilden.
        // Siehe Konzeptplan "AllianceWindow_RelationshipManager".
        // =========================================================
        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliances (
                id SERIAL PRIMARY KEY,
                display_id TEXT UNIQUE,
                name TEXT NOT NULL,
                tag TEXT NOT NULL UNIQUE,
                logo_id INTEGER NOT NULL DEFAULT 0,
                description TEXT NOT NULL DEFAULT '',
                placeholder_01 TEXT NOT NULL DEFAULT '',
                placeholder_02 TEXT NOT NULL DEFAULT '',
                placeholder_03 TEXT NOT NULL DEFAULT '',
                founder_commander_id INTEGER NOT NULL,
                points INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        // Absicherung falls die Tabelle schon vor display_id existierte
        // (gleiches Muster wie bei sender_avatar_index vorhin)
        await pool.query(`ALTER TABLE alliances ADD COLUMN IF NOT EXISTS display_id TEXT;`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alliances_display_id ON alliances (display_id) WHERE display_id IS NOT NULL;`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliances_name ON alliances (name);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliances_tag ON alliances (tag);`);

        // Global fortlaufende Nummer für den Allianz-ID-Bestandteil
        // (Datum + Galaxie + diese Zahl) — atomar, wie bei
        // combat_report_seq/mail_id_seq bereits etabliert.
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS alliance_id_seq;`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliance_members (
                id SERIAL PRIMARY KEY,
                alliance_id INTEGER NOT NULL REFERENCES alliances(id) ON DELETE CASCADE,
                commander_id INTEGER NOT NULL,
                commander_name TEXT NOT NULL,
                commander_coord TEXT,
                role TEXT NOT NULL DEFAULT 'member',
                joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(commander_id)
            );
        `);
        await pool.query(`ALTER TABLE alliance_members ADD COLUMN IF NOT EXISTS commander_coord TEXT;`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_members_alliance ON alliance_members (alliance_id);`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliance_charters (
                id SERIAL PRIMARY KEY,
                founder_commander_id INTEGER NOT NULL,
                founder_name TEXT NOT NULL,
                founder_coord TEXT,
                founder_galaxy_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL,
                tag TEXT NOT NULL,
                logo_id INTEGER NOT NULL DEFAULT 0,
                description TEXT NOT NULL DEFAULT '',
                placeholder_01 TEXT NOT NULL DEFAULT '',
                placeholder_02 TEXT NOT NULL DEFAULT '',
                placeholder_03 TEXT NOT NULL DEFAULT '',
                required_signatures INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'pending',
                resulting_alliance_id INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
            );
        `);
        await pool.query(`ALTER TABLE alliance_charters ADD COLUMN IF NOT EXISTS founder_coord TEXT;`);
        await pool.query(`ALTER TABLE alliance_charters ADD COLUMN IF NOT EXISTS founder_galaxy_id INTEGER NOT NULL DEFAULT 1;`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_charters_status ON alliance_charters (status, created_at DESC);`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliance_charter_signatures (
                id SERIAL PRIMARY KEY,
                charter_id INTEGER NOT NULL REFERENCES alliance_charters(id) ON DELETE CASCADE,
                signer_commander_id INTEGER NOT NULL,
                signer_name TEXT NOT NULL,
                signer_coord TEXT,
                signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(charter_id, signer_commander_id)
            );
        `);
        await pool.query(`ALTER TABLE alliance_charter_signatures ADD COLUMN IF NOT EXISTS signer_coord TEXT;`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS player_relationships (
                id SERIAL PRIMARY KEY,
                commander_id_a INTEGER NOT NULL,
                commander_id_b INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'neutral',
                requested_by INTEGER,
                established_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                expires_at TIMESTAMPTZ,
                peace_cooldown_until TIMESTAMPTZ,
                UNIQUE(commander_id_a, commander_id_b)
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_player_relationships_a ON player_relationships (commander_id_a);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_player_relationships_b ON player_relationships (commander_id_b);`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliance_relationships (
                id SERIAL PRIMARY KEY,
                alliance_id_a INTEGER NOT NULL,
                alliance_id_b INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'neutral',
                established_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(alliance_id_a, alliance_id_b)
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_relationships_a ON alliance_relationships (alliance_id_a);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_relationships_b ON alliance_relationships (alliance_id_b);`);
        // NEU (21.08., Phase 3): requested_by für den Anfrage-Fluss bei
        // 'ally'/'nap' (brauchen beidseitige Zustimmung, anders als 'war'),
        // expires_at schon jetzt mit angelegt (Phase 4: Ablaufzeit für
        // Bündnisse), gleiches Muster wie bei display_id vorhin.
        await pool.query(`ALTER TABLE alliance_relationships ADD COLUMN IF NOT EXISTS requested_by INTEGER;`);
        await pool.query(`ALTER TABLE alliance_relationships ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);

        // NEU (22.08.): Bewerbungssystem — echte Zustimmungspflicht statt
        // direktem Beitritt. UNIQUE(alliance_id, commander_id) verhindert
        // doppelte Bewerbungen bei derselben Allianz (erneutes Bewerben
        // aktualisiert stattdessen die bestehende Zeile, siehe Endpunkt).
        // commander_coord wird gebraucht, damit sendAllianceMail() den
        // Empfänger überhaupt finden kann (siehe Datei-Kommentar dort).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliance_applications (
                id SERIAL PRIMARY KEY,
                alliance_id INTEGER NOT NULL,
                commander_id INTEGER NOT NULL,
                commander_name TEXT NOT NULL,
                commander_coord TEXT,
                message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
                UNIQUE(alliance_id, commander_id)
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_applications_alliance ON alliance_applications (alliance_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_applications_commander ON alliance_applications (commander_id);`);

        // NEU (22.08., Phase R1): Frei konfigurierbare Ränge pro Allianz —
        // ersetzt das feste role-Feld ('founder'/'member') langfristig.
        // rank_order: 0 = höchste Autorität, höher = weniger Rechte. Wird
        // NICHT für Rechte-Prüfungen genutzt (das machen die einzelnen
        // can_*-Spalten) — dient nur der SORTIERUNG in der Mitgliederliste.
        //
        // is_founder_rank: GENAU EIN Rang pro Allianz trägt das. Hat IMMER
        // alle Rechte, unabhängig von den can_*-Spalten (verhindert, dass
        // sich ein Gründer versehentlich selbst aussperrt). Name/Tag/Logo
        // ändern + Allianz auflösen bleiben zusätzlich FEST an diesen einen
        // Rang gebunden (nicht über can_*-Spalten delegierbar), das wird in
        // Phase R2 direkt gegen is_founder_rank geprüft, nicht gegen can_*.
        //
        // is_default_rank: GENAU EIN Rang pro Allianz — wird neuen
        // Mitgliedern automatisch zugewiesen (Beitritt/Bewerbung
        // angenommen). Bewusst ein eigenes Flag statt "Name == Mitglied"
        // zu prüfen, weil ALLE Rangnamen frei umbenennbar sein sollen
        // (auch "Mitglied" selbst) — ein Namens-Abgleich wäre nach einer
        // Umbenennung kaputt, das Flag bleibt stabil.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS alliance_ranks (
                id SERIAL PRIMARY KEY,
                alliance_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                rank_order INTEGER NOT NULL DEFAULT 100,
                is_founder_rank BOOLEAN NOT NULL DEFAULT false,
                is_default_rank BOOLEAN NOT NULL DEFAULT false,
                can_manage_applications  BOOLEAN NOT NULL DEFAULT false,
                can_manage_relationships BOOLEAN NOT NULL DEFAULT false,
                can_edit_alliance_info   BOOLEAN NOT NULL DEFAULT false,
                can_kick_members         BOOLEAN NOT NULL DEFAULT false,
                can_promote_members      BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alliance_ranks_alliance ON alliance_ranks (alliance_id);`);

        // rank_id auf alliance_members — NULLABLE für Übergangszeit
        // (bestehende Mitglieder aus VOR diesem Update haben noch
        // keinen Rang, werden beim nächsten eigenen Login/Refresh über
        // das alte 'role'-Feld nachträglich zugeordnet, siehe Phase R2).
        await pool.query(`ALTER TABLE alliance_members ADD COLUMN IF NOT EXISTS rank_id INTEGER;`);

        // NEU (22.08., Phase R2): Einmalige Migration — bestehende
        // Allianzen (gegründet VOR Phase R1) haben noch keine Ränge und
        // keinen rank_id bei ihren Mitgliedern. Läuft bei jedem Server-
        // Start, aber idempotent: findet beim zweiten Mal nichts mehr zu
        // tun (WHERE rank_id IS NULL greift dann ins Leere).
        await backfillAllianceRanks();

        // -------------------------------------------------------
        // Commander-Highscore — wird bei jedem /serverTick (alle 5 Min)
        // für ALLE aktiven Spieler neu berechnet. Läuft über unseren
        // eigenen Server (nicht PlayFab), damit's eine echte, für ALLE
        // Spieler durchsuchbare/sortierbare Liste ist, nicht nur die
        // eigene, lokal berechnete Punktzahl.
        // -------------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS commander_highscore (
                commander_id INTEGER PRIMARY KEY,
                commander_name TEXT NOT NULL,
                avatar_index INTEGER NOT NULL DEFAULT 0,
                playfab_id TEXT,
                total_points INTEGER NOT NULL DEFAULT 0,
                fleet_points INTEGER NOT NULL DEFAULT 0,
                infrastructure_points INTEGER NOT NULL DEFAULT 0,
                research_points INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`ALTER TABLE commander_highscore ADD COLUMN IF NOT EXISTS avatar_index INTEGER NOT NULL DEFAULT 0;`);
        await pool.query(`ALTER TABLE commander_highscore ADD COLUMN IF NOT EXISTS playfab_id TEXT;`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_commander_highscore_points ON commander_highscore (total_points DESC);`);

        // -------------------------------------------------------
        // Rechtstexte (aktuell: spielregeln/agb/datenschutz) — über den
        // eigenen Server ausgeliefert statt über PlayFab Title Data, weil
        // PlayFab-Client-Aufrufe grundsätzlich einen eingeloggten Spieler
        // voraussetzen. Ein Spieler soll "Rechtliches" aber schon VOR
        // Login/Registrierung lesen können (Tab03 im Login-Fenster) —
        // der eigene Server ist dafür schon offen erreichbar (CORS *,
        // kein Auth nötig), genau wie /announcements.
        //
        // NEU: version-Spalte. Jedes Mal, wenn sich der content eines
        // Keys über PUT wirklich ändert, wird version automatisch um 1
        // erhöht (siehe PUT /legal-texts/:key). Der Client vergleicht
        // diese Version mit der Version, der ein Spieler zuletzt
        // zugestimmt hat (gespeichert in PlayFab, siehe SessionManager.cs
        // GetAcceptedLegalVersions/SaveAcceptedLegalVersions) — weicht
        // sie ab, muss erneut zugestimmt werden, ganz ohne dass der
        // Server selbst irgendetwas über "Zustimmung" wissen müsste.
        // -------------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS legal_texts (
                key TEXT PRIMARY KEY,
                content TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`ALTER TABLE legal_texts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`);

        // -------------------------------------------------------
        // Support-Kontaktformular (Tab04 im Login-Fenster) — landet
        // NICHT als Ingame-Mail beim Admin (anders als /reportBug),
        // sondern in einer eigenen Tabelle. Grund: Support-Anfragen
        // können auch von noch nicht eingeloggten/neuen Spielern kommen
        // (z.B. "Ich komme mit der Registrierung nicht klar"), für die
        // es noch gar keinen Commander/keine Inbox gibt. sender_commander_id
        // ist deshalb bewusst NULLABLE.
        // -------------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_messages (
                id SERIAL PRIMARY KEY,
                sender_commander_id INTEGER,
                sender_name TEXT,
                sender_email TEXT,
                message TEXT NOT NULL,
                is_read BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON support_messages (created_at DESC);`);

        console.log('[DB] legal_texts + support_messages bereit.');

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
// Entwickler-ToDo-Liste — GET ist für alle Spieler offen (Roadmap-Ansicht),
// POST/PUT/DELETE sind nicht extra abgesichert (kleines Solo-Projekt,
// kein sensibler Inhalt) — der Admin-Modus-Schutz passiert rein im
// Client (Buttons nur im Admin-Modus sichtbar/aktiv).
// -------------------------------------------------------
// NEU (21.08.): War komplett ungeschützt — jeder, der die URL kannte,
// konnte eure internen Dev-Notizen lesen UND SCHREIBEN. Gleicher Schutz
// wie /admin/reports weiter unten (bereits vorhandene ADMIN_KEY-
// Umgebungsvariable, keine neue nötig).
function checkAdminKey(req, res) {
    if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
        res.status(403).json({ success: false, error: 'Nicht autorisiert' });
        return false;
    }
    return true;
}

app.get('/devtodos', async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    try {
        const result = await pool.query('SELECT * FROM dev_todos ORDER BY status ASC, created_at DESC');
        res.json({ success: true, todos: result.rows });
    } catch (error) {
        console.error('[Server] devtodos GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/devtodos', async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const { text } = req.body;
    if (!text || !text.trim())
        return res.status(400).json({ success: false, error: 'Kein Text' });

    try {
        const result = await pool.query(
            'INSERT INTO dev_todos (text, status) VALUES ($1, $2) RETURNING *',
            [text.trim(), 'open']
        );
        res.json({ success: true, todo: result.rows[0] });
    } catch (error) {
        console.error('[Server] devtodos POST Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/devtodos/:id', async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const { text, status } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        const existing = await pool.query('SELECT * FROM dev_todos WHERE id = $1', [id]);
        if (existing.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Nicht gefunden' });

        const newText = text !== undefined ? text.trim() : existing.rows[0].text;
        const newStatus = status !== undefined ? status : existing.rows[0].status;

        const result = await pool.query(
            'UPDATE dev_todos SET text = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *',
            [newText, newStatus, id]
        );
        res.json({ success: true, todo: result.rows[0] });
    } catch (error) {
        console.error('[Server] devtodos PUT Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/devtodos/:id', async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        await pool.query('DELETE FROM dev_todos WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] devtodos DELETE Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// "Ankündigungen"-Kanal — GET ist für alle Spieler offen, POST/PUT nur
// für TheVirgoDominion (Commander-ID 1000000). Diese Prüfung läuft
// serverseitig (nicht nur im Client), damit sie sich nicht einfach
// umgehen lässt.
// -------------------------------------------------------
app.get('/announcements', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 200);
        const result = await pool.query(
            'SELECT * FROM announcements ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        res.json({ success: true, announcements: result.rows.reverse() }); // älteste zuerst
    } catch (error) {
        console.error('[Server] announcements GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/announcements', async (req, res) => {
    const { senderCommanderId, senderName, senderAvatarIndex, text } = req.body;

    if (!ADMIN_COMMANDER_IDS.includes(senderCommanderId))
        return res.status(403).json({ success: false, error: 'Nur TheVirgoDominion darf hier posten.' });
    if (!text || !text.trim())
        return res.status(400).json({ success: false, error: 'Kein Text' });

    try {
        const result = await pool.query(
            'INSERT INTO announcements (sender_commander_id, sender_name, sender_avatar_index, text) VALUES ($1, $2, $3, $4) RETURNING *',
            [senderCommanderId, senderName || 'TheVirgoDominion', senderAvatarIndex || 0, text.trim()]
        );
        res.json({ success: true, announcement: result.rows[0] });
    } catch (error) {
        console.error('[Server] announcements POST Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/announcements/:id/done', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { requesterCommanderId, isDone } = req.body;

    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur TheVirgoDominion darf das Häkchen ändern.' });
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        const doneTimestamp = isDone ? new Date() : null;
        const result = await pool.query(
            'UPDATE announcements SET is_done = $1, done_timestamp = $2 WHERE id = $3 RETURNING *',
            [!!isDone, doneTimestamp, id]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Nicht gefunden' });
        res.json({ success: true, announcement: result.rows[0] });
    } catch (error) {
        console.error('[Server] announcements PUT Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// "TheVirgoDominion"-Kanal — GET für alle offen, POST nur für Admins.
// Kein Häkchen/Status nötig, deshalb schlanker als "announcements".
// -------------------------------------------------------
app.get('/virgodom-messages', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 200);
        const result = await pool.query(
            'SELECT * FROM virgodom_messages ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        res.json({ success: true, messages: result.rows.reverse() }); // älteste zuerst
    } catch (error) {
        console.error('[Server] virgodom-messages GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/virgodom-messages', async (req, res) => {
    const { senderCommanderId, senderName, senderAvatarIndex, text } = req.body;

    if (!ADMIN_COMMANDER_IDS.includes(senderCommanderId))
        return res.status(403).json({ success: false, error: 'Nur TheVirgoDominion darf hier posten.' });
    if (!text || !text.trim())
        return res.status(400).json({ success: false, error: 'Kein Text' });

    try {
        const result = await pool.query(
            'INSERT INTO virgodom_messages (sender_commander_id, sender_name, sender_avatar_index, text) VALUES ($1, $2, $3, $4) RETURNING *',
            [senderCommanderId, senderName || 'TheVirgoDominion', senderAvatarIndex || 0, text.trim()]
        );
        res.json({ success: true, message: result.rows[0] });
    } catch (error) {
        console.error('[Server] virgodom-messages POST Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// ALLIANZEN
// =========================================================

// Hilfsfunktion: liefert [kleinereId, groessereId] — feste Konvention,
// damit eine Beziehung zwischen A und B nie versehentlich als ZWEI
// getrennte Zeilen (A->B und B->A) gespeichert wird.
function orderIds(x, y) {
    return x < y ? [x, y] : [y, x];
}

async function getAllianceIdForCommander(commanderId) {
    const result = await pool.query('SELECT alliance_id FROM alliance_members WHERE commander_id = $1', [commanderId]);
    return result.rows.length > 0 ? result.rows[0].alliance_id : null;
}

// -------------------------------------------------------
// Allianz-Anzeige-ID erzeugen: JJMMTT + Galaxie (2-stellig) +
// fortlaufende Nummer (3-stellig, atomar aus Postgres-Sequenz).
// Beispiel: 26.08.2026, Galaxie 1, 1. Allianz des Tages -> "26080901001"
// Einmal vergeben, NIE mehr änderbar (siehe Konzeptplan).
// -------------------------------------------------------
async function generateAllianceDisplayId(galaxyId) {
    const now = new Date();
    const p = getBerlinParts(now);
    const yy = p.year.slice(-2);
    const seqResult = await pool.query("SELECT nextval('alliance_id_seq') AS seq");
    const seq = String(seqResult.rows[0].seq).padStart(3, '0');
    const galaxyPadded = String(galaxyId || 1).padStart(2, '0');
    return `${yy}${p.month}${p.day}${galaxyPadded}${seq}`;
}

// -------------------------------------------------------
// Mail an einen Spieler schicken, identifiziert nur über commanderId +
// eine seiner Planeten-Koordinaten (Allianzen kennen keine PlayFabId,
// nur commanderId — der Umweg über die öffentlichen Systemdaten, wie
// beim Kampfbericht/notifyAttack, macht das trotzdem möglich).
// -------------------------------------------------------
async function sendAllianceMail(commanderId, coord, subject, body) {
    if (!coord) {
        console.warn(`[Server] sendAllianceMail: keine Koordinate für Commander ${commanderId}, Mail übersprungen.`);
        return;
    }
    try {
        const ownerInfo = await getPlanetOwnerInfo(coord);
        if (!ownerInfo || !ownerInfo.pfid) return;

        const data = await playfabServer('/Server/GetUserData', {
            PlayFabId: ownerInfo.pfid,
            Keys: ['commander_data']
        });
        if (!data.Data?.['commander_data']) return;

        const commander = JSON.parse(data.Data['commander_data'].Value);
        if (!commander.inbox) commander.inbox = [];

        const mailSeq = await getNextMailSeq();
        commander.inbox.push({
            mailId: `M-${commander.commanderId}-${mailSeq}`,
            category: 0, // System
            subject,
            body,
            senderName: 'Allianz-System', // LOCALIZE
            senderId: 0,
            isRead: false,
            isFavorite: false,
            timestamp: formatTimestamp(new Date()),
            reportId: ''
        });

        await playfabServer('/Server/UpdateUserData', {
            PlayFabId: ownerInfo.pfid,
            Data: { 'commander_data': JSON.stringify(commander) },
            Permission: 'Private'
        });
    } catch (e) {
        console.error(`[Server] sendAllianceMail Fehler (Commander ${commanderId}):`, e.message);
    }
}

// Durchsuchbare Liste ALLER Allianzen — ?search=... filtert auf Name/Tag
app.get('/alliances', async (req, res) => {
    try {
        const search = (req.query.search || '').trim();
        let result;
        if (search) {
            result = await pool.query(
                `SELECT a.*, (SELECT COUNT(*) FROM alliance_members m WHERE m.alliance_id = a.id) AS member_count
                 FROM alliances a
                 WHERE a.name ILIKE $1 OR a.tag ILIKE $1
                 ORDER BY a.points DESC LIMIT 100`,
                [`%${search}%`]
            );
        } else {
            result = await pool.query(
                `SELECT a.*, (SELECT COUNT(*) FROM alliance_members m WHERE m.alliance_id = a.id) AS member_count
                 FROM alliances a ORDER BY a.points DESC LIMIT 100`
            );
        }
        res.json({ success: true, alliances: result.rows });
    } catch (error) {
        console.error('[Server] alliances GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/alliances/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        const result = await pool.query(
            `SELECT a.*, (SELECT COUNT(*) FROM alliance_members m WHERE m.alliance_id = a.id) AS member_count
             FROM alliances a WHERE a.id = $1`,
            [id]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });
        res.json({ success: true, alliance: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliances/:id GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/alliances/:id/members', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        // ERWEITERT (22.08., Phase R4): Rang-Info + Rechte (für Dropdown/
        // "nur nach unten"-Prüfung im Client) + Punkte (für die Sortierung,
        // wie ursprünglich geplant: erst Rang, dann Punkte) + zuletzt aktiv
        // (Wiederverwendung von commander_highscore.updated_at, kein neuer
        // Tracking-Code nötig) — alles in EINEM Aufruf statt mehrerer.
        const result = await pool.query(
            `SELECT m.*,
                    r.name AS rank_name, r.rank_order, r.is_founder_rank, r.is_default_rank,
                    r.can_manage_applications, r.can_manage_relationships, r.can_edit_alliance_info,
                    r.can_kick_members, r.can_promote_members,
                    COALESCE(h.total_points, 0) AS total_points,
                    h.updated_at AS last_active_at
             FROM alliance_members m
             LEFT JOIN alliance_ranks r ON r.id = m.rank_id
             LEFT JOIN commander_highscore h ON h.commander_id = m.commander_id
             WHERE m.alliance_id = $1
             ORDER BY COALESCE(r.rank_order, 999) ASC, COALESCE(h.total_points, 0) DESC`,
            [id]
        );
        res.json({ success: true, members: result.rows });
    } catch (error) {
        console.error('[Server] alliances/:id/members GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Direkter Beitritt (Alpha-Vereinfachung, keine Bewerbung/Einladung nötig)
app.post('/alliances/:id/join', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { commanderId, commanderName, commanderCoord } = req.body;
    if (!id || !commanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        const existing = await getAllianceIdForCommander(commanderId);
        if (existing)
            return res.status(400).json({ success: false, error: 'Du bist bereits Mitglied einer Allianz. Erst austreten.' });

        const allianceCheck = await pool.query('SELECT * FROM alliances WHERE id = $1', [id]);
        if (allianceCheck.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });
        const alliance = allianceCheck.rows[0];

        const defaultRankId = await getDefaultRankId(id);
        await pool.query(
            'INSERT INTO alliance_members (alliance_id, commander_id, commander_name, commander_coord, role, rank_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, commanderId, commanderName || 'Unbekannt', commanderCoord || null, 'member', defaultRankId]
        );

        await sendAllianceMail(commanderId, commanderCoord,
            'Allianz beigetreten', // LOCALIZE
            `Du bist der Allianz "${alliance.name}" [${alliance.tag}] beigetreten.`); // LOCALIZE

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] alliances/:id/join Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// NEU (22.08.): Bewerbungssystem — echte Zustimmungspflicht statt
// direktem Beitritt. Ablauf:
// 1) apply: Bewerbung mit Nachricht (max 200 Zeichen), 24h gültig.
// 2) Gründer sieht Liste über GET /alliances/:id/applications.
// 3) accept -> Beitritt + Mail "angenommen".
//    reject -> KEIN Beitritt + Mail "abgelehnt".
//    Ablauf ohne Reaktion (serverTick, siehe expireOldApplications) ->
//    stilles Löschen, KEINE Mail (bewusster Unterschied zwischen
//    Ignorieren und aktivem Ablehnen — siehe Chat vom 22.08.).
// GET /commander/:id/applications zeigt EIGENE offene Bewerbungen (für
// den Countdown-Timer anstelle des "Bewerben"-Buttons in der Highscore-
// Liste), selbst-only geschützt wie /relationships und /colonies.
// =========================================================

app.post('/alliances/:id/apply', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { commanderId, commanderName, commanderCoord, message } = req.body;
    if (!id || !commanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    const trimmedMessage = (message || '').trim().slice(0, 200); // Server-seitige Begrenzung, unabhängig vom Client

    try {
        const existingAlliance = await getAllianceIdForCommander(commanderId);
        if (existingAlliance)
            return res.status(400).json({ success: false, error: 'Du bist bereits Mitglied einer Allianz.' });

        const allianceCheck = await pool.query('SELECT id FROM alliances WHERE id = $1', [id]);
        if (allianceCheck.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });

        const result = await pool.query(
            `INSERT INTO alliance_applications (alliance_id, commander_id, commander_name, commander_coord, message, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, now(), now() + interval '24 hours')
             ON CONFLICT (alliance_id, commander_id)
             DO UPDATE SET commander_name = $3, commander_coord = $4, message = $5, created_at = now(), expires_at = now() + interval '24 hours'
             RETURNING *`,
            [id, commanderId, commanderName || 'Unbekannt', commanderCoord || null, trimmedMessage]
        );
        res.json({ success: true, application: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliances/:id/apply Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/alliances/:id/applications', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const requesterCommanderId = parseInt(req.query.requesterCommanderId, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });
    if (!requesterCommanderId) return res.status(400).json({ success: false, error: 'Fehlender requesterCommanderId-Parameter' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, id, 'can_manage_applications')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, Bewerbungen einzusehen.' });

        const result = await pool.query(
            'SELECT * FROM alliance_applications WHERE alliance_id = $1 ORDER BY created_at ASC',
            [id]
        );
        res.json({ success: true, applications: result.rows });
    } catch (error) {
        console.error('[Server] alliances/:id/applications GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eigene offene Bewerbungen (über ALLE Allianzen hinweg) — für den
// Countdown-Timer in der Highscore-Liste. Selbst-only, wie bei
// /relationships und /commander/:id/colonies.
app.get('/commander/:id/applications', async (req, res) => {
    const commanderId = parseInt(req.params.id, 10);
    const requesterId = parseInt(req.query.requesterId, 10);
    if (!commanderId) return res.status(400).json({ success: false, error: 'Ungueltige ID' });
    if (requesterId !== commanderId)
        return res.status(403).json({ success: false, error: 'Nur eigene Bewerbungen einsehbar.' });

    try {
        const result = await pool.query(
            'SELECT * FROM alliance_applications WHERE commander_id = $1',
            [commanderId]
        );
        res.json({ success: true, applications: result.rows });
    } catch (error) {
        console.error('[Server] commander/:id/applications GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliances/:id/applications/:appId/accept', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const appId = parseInt(req.params.appId, 10);
    const { requesterCommanderId } = req.body;
    if (!id || !appId || !requesterCommanderId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, id, 'can_manage_applications')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, Bewerbungen anzunehmen.' });

        const appResult = await pool.query(
            'SELECT * FROM alliance_applications WHERE id = $1 AND alliance_id = $2',
            [appId, id]
        );
        if (appResult.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Bewerbung nicht gefunden (evtl. abgelaufen).' });
        const application = appResult.rows[0];

        // Bewerber könnte zwischenzeitlich einer ANDEREN Allianz
        // beigetreten sein — dann Bewerbung nur aufräumen, nicht annehmen.
        const existingAlliance = await getAllianceIdForCommander(application.commander_id);
        if (existingAlliance) {
            await pool.query('DELETE FROM alliance_applications WHERE id = $1', [appId]);
            return res.status(400).json({ success: false, error: 'Bewerber ist inzwischen einer anderen Allianz beigetreten.' });
        }

        const allianceResult = await pool.query('SELECT name, tag FROM alliances WHERE id = $1', [id]);
        const alliance = allianceResult.rows[0];

        const defaultRankId = await getDefaultRankId(id);
        await pool.query(
            'INSERT INTO alliance_members (alliance_id, commander_id, commander_name, commander_coord, role, rank_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, application.commander_id, application.commander_name, application.commander_coord, 'member', defaultRankId]
        );
        await pool.query('DELETE FROM alliance_applications WHERE id = $1', [appId]);

        await sendAllianceMail(application.commander_id, application.commander_coord,
            'Bewerbung angenommen', // LOCALIZE
            `Deine Bewerbung bei der Allianz "${alliance.name}" [${alliance.tag}] wurde angenommen! Willkommen an Bord.`); // LOCALIZE

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] applications/accept Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliances/:id/applications/:appId/reject', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const appId = parseInt(req.params.appId, 10);
    const { requesterCommanderId } = req.body;
    if (!id || !appId || !requesterCommanderId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, id, 'can_manage_applications')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, Bewerbungen abzulehnen.' });

        const appResult = await pool.query(
            'SELECT * FROM alliance_applications WHERE id = $1 AND alliance_id = $2',
            [appId, id]
        );
        if (appResult.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Bewerbung nicht gefunden (evtl. abgelaufen).' });
        const application = appResult.rows[0];

        const allianceResult = await pool.query('SELECT name, tag FROM alliances WHERE id = $1', [id]);
        const alliance = allianceResult.rows[0];

        await pool.query('DELETE FROM alliance_applications WHERE id = $1', [appId]);

        // BEWUSSTER Unterschied zu einem stillen Ablauf (siehe
        // expireOldApplications im serverTick) — aktive Ablehnung
        // bekommt eine Mail, Ignorieren nicht.
        await sendAllianceMail(application.commander_id, application.commander_coord,
            'Bewerbung abgelehnt', // LOCALIZE
            `Deine Bewerbung bei der Allianz "${alliance.name}" [${alliance.tag}] wurde leider abgelehnt.`); // LOCALIZE

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] applications/reject Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliances/:id/leave', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { commanderId } = req.body;
    if (!id || !commanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        // Koordinate + Allianzname VOR dem Löschen holen (danach weg)
        const memberResult = await pool.query(
            'SELECT commander_coord FROM alliance_members WHERE alliance_id = $1 AND commander_id = $2',
            [id, commanderId]
        );
        const allianceResult = await pool.query('SELECT name, tag FROM alliances WHERE id = $1', [id]);

        await pool.query('DELETE FROM alliance_members WHERE alliance_id = $1 AND commander_id = $2', [id, commanderId]);

        if (memberResult.rows.length > 0 && allianceResult.rows.length > 0) {
            const coord = memberResult.rows[0].commander_coord;
            const alliance = allianceResult.rows[0];

            // FIX (21.08.): Vorher blieb die Allianz-Zeile (mit Name/Tag)
            // für immer verwaist in der Datenbank stehen, auch wenn das
            // letzte Mitglied ging — Name/Tag blieben dadurch dauerhaft
            // blockiert, obwohl die Allianz aus Spielersicht "aufgelöst"
            // war. Jetzt: prüfen, ob nach dem Austritt noch Mitglieder
            // übrig sind — falls nicht, die Allianz selbst mit löschen
            // (CASCADE entfernt evtl. Restdaten mit, ist an dieser Stelle
            // aber ohnehin schon leer).
            const remainingResult = await pool.query(
                'SELECT COUNT(*) AS cnt FROM alliance_members WHERE alliance_id = $1',
                [id]
            );
            const remaining = parseInt(remainingResult.rows[0].cnt, 10);

            if (remaining === 0) {
                await pool.query('DELETE FROM alliances WHERE id = $1', [id]);
                await sendAllianceMail(commanderId, coord,
                    'Allianz aufgelöst', // LOCALIZE
                    `Die Allianz "${alliance.name}" [${alliance.tag}] wurde aufgelöst, da du als letztes Mitglied ausgetreten bist. Name und Tag sind wieder frei verfügbar.`); // LOCALIZE
            } else {
                await sendAllianceMail(commanderId, coord,
                    'Allianz verlassen', // LOCALIZE
                    `Du hast die Allianz "${alliance.name}" [${alliance.tag}] verlassen.`); // LOCALIZE
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] alliances/:id/leave Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEU (21.08.): Gründer/Anführer dürfen die EIGENE Allianz bearbeiten —
// vorher konnte das nur ein Admin-Account über die /admin/-Endpunkte
// weiter unten. Prüft die Rolle in alliance_members, nicht
// ADMIN_COMMANDER_IDS. Alle Felder optional — nur mitschicken, was
// geändert werden soll.
app.put('/alliances/:id/edit', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { commanderId, name, tag, logoId, description } = req.body;
    if (!id || !commanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        // UMGESTELLT (Phase R2): Name/Tag/Logo bleiben FEST an den
        // Gründer-Rang gebunden (bewusst NICHT über can_edit_alliance_info
        // delegierbar — Umbenennen/Rebranding ist eine strukturelle
        // Entscheidung). Die Beschreibung dagegen IST delegierbar, für
        // Offiziere/Ministerien mit dem passenden Recht.
        const wantsStructuralChange = name !== undefined || tag !== undefined || logoId !== undefined;
        const wantsDescriptionChange = description !== undefined;

        if (wantsStructuralChange && !(await isAllianceFounder(commanderId, id)))
            return res.status(403).json({ success: false, error: 'Nur der Gründer darf Name/Tag/Logo ändern.' });

        if (wantsDescriptionChange && !(await allianceHasPermission(commanderId, id, 'can_edit_alliance_info')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, die Beschreibung zu bearbeiten.' });

        const updates = [];
        const values = [];
        let idx = 1;

        if (name !== undefined) {
            const trimmed = (name || '').trim();
            if (trimmed.length < 6 || trimmed.length > 30)
                return res.status(400).json({ success: false, error: 'Name muss 6-30 Zeichen haben' });
            updates.push(`name = $${idx++}`); values.push(trimmed);
        }
        if (tag !== undefined) {
            const trimmedTag = (tag || '').trim().toUpperCase();
            if (trimmedTag.length < 3 || trimmedTag.length > 6)
                return res.status(400).json({ success: false, error: 'Tag muss 3-6 Zeichen haben' });
            const tagTaken = await pool.query('SELECT id FROM alliances WHERE tag = $1 AND id != $2', [trimmedTag, id]);
            if (tagTaken.rows.length > 0)
                return res.status(400).json({ success: false, error: 'Dieses Allianz-Tag ist bereits vergeben.' });
            updates.push(`tag = $${idx++}`); values.push(trimmedTag);
        }
        if (logoId !== undefined) {
            // Gleiche Regel wie bei der Gründung: Logo 0 bleibt Admin-Accounts vorbehalten.
            if (logoId === 0 && !ADMIN_COMMANDER_IDS.includes(commanderId))
                return res.status(403).json({ success: false, error: 'Dieses Logo ist Admin-Accounts vorbehalten.' });
            updates.push(`logo_id = $${idx++}`); values.push(logoId);
        }
        if (description !== undefined) {
            if ((description || '').length > 1000)
                return res.status(400).json({ success: false, error: 'Beschreibung zu lang (max. 1000 Zeichen)' });
            updates.push(`description = $${idx++}`); values.push(description || '');
        }

        if (updates.length === 0)
            return res.status(400).json({ success: false, error: 'Keine Änderungen übergeben.' });

        values.push(id);
        const result = await pool.query(
            `UPDATE alliances SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        res.json({ success: true, alliance: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliances/:id/edit PUT Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// NEU (22.08., Phase R3): Rang-Verwaltung + Mitglieder-Aktionen
// (Befördern/Kicken). Rang-CRUD ist bewusst GRÜNDER-ONLY (nicht über
// can_*-Spalten delegierbar) — sonst könnte sich ein Offizier mit
// can_promote_members selbst über eine neu erstellte Rang-Definition
// mehr Rechte verschaffen, als der Gründer ihm zugedacht hat.
// =========================================================

// Rang-Liste — für ALLE Mitglieder einsehbar (nicht nur Gründer/
// Offiziere), z.B. für das Dropdown bei der Mitgliederliste und um
// überhaupt zu sehen, welche Ministerien es gibt.
app.get('/alliances/:id/ranks', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const requesterCommanderId = parseInt(req.query.requesterCommanderId, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });
    if (!requesterCommanderId) return res.status(400).json({ success: false, error: 'Fehlender requesterCommanderId-Parameter' });

    try {
        const memberCheck = await pool.query(
            'SELECT 1 FROM alliance_members WHERE alliance_id = $1 AND commander_id = $2',
            [id, requesterCommanderId]
        );
        if (memberCheck.rows.length === 0)
            return res.status(403).json({ success: false, error: 'Nur Mitglieder dürfen die Ränge einsehen.' });

        const result = await pool.query(
            'SELECT * FROM alliance_ranks WHERE alliance_id = $1 ORDER BY rank_order ASC',
            [id]
        );
        res.json({ success: true, ranks: result.rows });
    } catch (error) {
        console.error('[Server] alliances/:id/ranks GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliances/:id/ranks', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { requesterCommanderId, name, rankOrder,
        canManageApplications, canManageRelationships, canEditAllianceInfo, canKickMembers, canPromoteMembers } = req.body;
    if (!id || !requesterCommanderId || !name)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await isAllianceFounder(requesterCommanderId, id)))
            return res.status(403).json({ success: false, error: 'Nur der Gründer darf neue Ränge erstellen.' });

        const trimmedName = name.trim();
        if (trimmedName.length < 1 || trimmedName.length > 30)
            return res.status(400).json({ success: false, error: 'Rangname muss 1-30 Zeichen haben.' });

        const result = await pool.query(
            `INSERT INTO alliance_ranks
                (alliance_id, name, rank_order, is_founder_rank, is_default_rank,
                 can_manage_applications, can_manage_relationships, can_edit_alliance_info, can_kick_members, can_promote_members)
             VALUES ($1, $2, $3, false, false, $4, $5, $6, $7, $8)
             RETURNING *`,
            [id, trimmedName, rankOrder || 50,
             !!canManageApplications, !!canManageRelationships, !!canEditAllianceInfo, !!canKickMembers, !!canPromoteMembers]
        );
        res.json({ success: true, rank: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliances/:id/ranks POST Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/alliances/:id/ranks/:rankId', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rankId = parseInt(req.params.rankId, 10);
    const { requesterCommanderId, name, rankOrder, isDefaultRank,
        canManageApplications, canManageRelationships, canEditAllianceInfo, canKickMembers, canPromoteMembers } = req.body;
    if (!id || !rankId || !requesterCommanderId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await isAllianceFounder(requesterCommanderId, id)))
            return res.status(403).json({ success: false, error: 'Nur der Gründer darf Ränge bearbeiten.' });

        const rankCheck = await pool.query('SELECT * FROM alliance_ranks WHERE id = $1 AND alliance_id = $2', [rankId, id]);
        if (rankCheck.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Rang nicht gefunden.' });

        // is_founder_rank selbst bleibt IMMER gesperrt — der Gründer-Rang
        // darf umbenannt werden (Name ist frei wählbar, siehe Plan), aber
        // niemals auf einen anderen Rang "übertragen" werden. Das ist eine
        // bewusste Einschränkung, kein Versehen — Gründerstatus-Transfer
        // wäre ein eigenes, deutlich größeres Feature.

        const updates = [];
        const values = [];
        let idx = 1;

        if (name !== undefined) {
            const trimmed = (name || '').trim();
            if (trimmed.length < 1 || trimmed.length > 30)
                return res.status(400).json({ success: false, error: 'Rangname muss 1-30 Zeichen haben.' });
            updates.push(`name = $${idx++}`); values.push(trimmed);
        }
        if (rankOrder !== undefined) { updates.push(`rank_order = $${idx++}`); values.push(rankOrder); }
        if (canManageApplications  !== undefined) { updates.push(`can_manage_applications = $${idx++}`);  values.push(!!canManageApplications); }
        if (canManageRelationships !== undefined) { updates.push(`can_manage_relationships = $${idx++}`); values.push(!!canManageRelationships); }
        if (canEditAllianceInfo    !== undefined) { updates.push(`can_edit_alliance_info = $${idx++}`);   values.push(!!canEditAllianceInfo); }
        if (canKickMembers         !== undefined) { updates.push(`can_kick_members = $${idx++}`);         values.push(!!canKickMembers); }
        if (canPromoteMembers      !== undefined) { updates.push(`can_promote_members = $${idx++}`);      values.push(!!canPromoteMembers); }

        if (isDefaultRank === true) {
            // Nur EIN Standard-Rang pro Allianz möglich — alten zuerst
            // zurücksetzen, dann neuen setzen.
            await pool.query('UPDATE alliance_ranks SET is_default_rank = false WHERE alliance_id = $1', [id]);
            updates.push(`is_default_rank = $${idx++}`); values.push(true);
        }

        if (updates.length === 0)
            return res.status(400).json({ success: false, error: 'Keine Änderungen übergeben.' });

        values.push(rankId);
        const result = await pool.query(
            `UPDATE alliance_ranks SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        res.json({ success: true, rank: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliances/:id/ranks PUT Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/alliances/:id/ranks/:rankId', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rankId = parseInt(req.params.rankId, 10);
    const { requesterCommanderId } = req.body;
    if (!id || !rankId) return res.status(400).json({ success: false, error: 'Ungueltige ID' });
    if (!requesterCommanderId) return res.status(400).json({ success: false, error: 'Fehlender requesterCommanderId-Parameter' });

    try {
        if (!(await isAllianceFounder(requesterCommanderId, id)))
            return res.status(403).json({ success: false, error: 'Nur der Gründer darf Ränge löschen.' });

        const rankCheck = await pool.query('SELECT * FROM alliance_ranks WHERE id = $1 AND alliance_id = $2', [rankId, id]);
        if (rankCheck.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Rang nicht gefunden.' });
        const rank = rankCheck.rows[0];

        if (rank.is_founder_rank)
            return res.status(400).json({ success: false, error: 'Der Gründer-Rang kann nicht gelöscht werden.' });
        if (rank.is_default_rank)
            return res.status(400).json({ success: false, error: 'Der Standard-Rang kann nicht gelöscht werden (erst einen anderen Rang als Standard festlegen).' });

        // Mitglieder mit diesem Rang auf den Standard-Rang zurückstufen,
        // BEVOR der Rang selbst gelöscht wird — sonst blieben sie mit
        // einem toten rank_id-Verweis zurück.
        const defaultRankId = await getDefaultRankId(id);
        await pool.query('UPDATE alliance_members SET rank_id = $1 WHERE alliance_id = $2 AND rank_id = $3', [defaultRankId, id, rankId]);
        await pool.query('DELETE FROM alliance_ranks WHERE id = $1', [rankId]);

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] alliances/:id/ranks DELETE Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// Mitglied befördern/degradieren — "nur nach unten": der Anfragende
// darf nur Mitglieder mit einer NIEDRIGEREN Autorität bearbeiten
// (höherer rank_order-Wert) als er selbst, und darf niemanden auf
// einen Rang befördern, der seinem eigenen gleichkommt oder ihn
// übersteigt. Gründer (is_founder_rank) umgeht diese Prüfung komplett.
// -------------------------------------------------------
app.post('/alliances/:id/members/:commanderId/promote', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const targetCommanderId = parseInt(req.params.commanderId, 10);
    const { requesterCommanderId, newRankId } = req.body;
    if (!id || !targetCommanderId || !requesterCommanderId || !newRankId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, id, 'can_promote_members')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, Mitglieder zu befördern.' });

        const requesterInfo = await getMemberRankInfo(requesterCommanderId, id);
        const targetInfo = await getMemberRankInfo(targetCommanderId, id);
        if (!requesterInfo || !targetInfo)
            return res.status(404).json({ success: false, error: 'Mitglied nicht gefunden.' });

        if (!requesterInfo.is_founder_rank && targetInfo.rank_order <= requesterInfo.rank_order)
            return res.status(403).json({ success: false, error: 'Du kannst nur Mitglieder unterhalb deines eigenen Rangs bearbeiten.' });

        const newRankResult = await pool.query('SELECT * FROM alliance_ranks WHERE id = $1 AND alliance_id = $2', [newRankId, id]);
        if (newRankResult.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Zielrang nicht gefunden.' });
        const newRank = newRankResult.rows[0];

        if (newRank.is_founder_rank)
            return res.status(403).json({ success: false, error: 'Der Gründer-Rang kann nicht zugewiesen werden.' });
        if (!requesterInfo.is_founder_rank && newRank.rank_order <= requesterInfo.rank_order)
            return res.status(403).json({ success: false, error: 'Du kannst niemanden auf oder über deinen eigenen Rang befördern.' });

        await pool.query('UPDATE alliance_members SET rank_id = $1 WHERE alliance_id = $2 AND commander_id = $3', [newRankId, id, targetCommanderId]);
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] members/:id/promote Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliances/:id/members/:commanderId/kick', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const targetCommanderId = parseInt(req.params.commanderId, 10);
    const { requesterCommanderId } = req.body;
    if (!id || !targetCommanderId || !requesterCommanderId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, id, 'can_kick_members')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, Mitglieder zu entfernen.' });

        const requesterInfo = await getMemberRankInfo(requesterCommanderId, id);
        const targetInfo = await getMemberRankInfo(targetCommanderId, id);
        if (!requesterInfo || !targetInfo)
            return res.status(404).json({ success: false, error: 'Mitglied nicht gefunden.' });

        if (targetInfo.is_founder_rank)
            return res.status(403).json({ success: false, error: 'Der Gründer kann nicht entfernt werden.' });
        if (!requesterInfo.is_founder_rank && targetInfo.rank_order <= requesterInfo.rank_order)
            return res.status(403).json({ success: false, error: 'Du kannst nur Mitglieder unterhalb deines eigenen Rangs entfernen.' });

        const memberResult = await pool.query(
            'SELECT commander_coord FROM alliance_members WHERE alliance_id = $1 AND commander_id = $2',
            [id, targetCommanderId]
        );
        const allianceResult = await pool.query('SELECT name, tag FROM alliances WHERE id = $1', [id]);

        await pool.query('DELETE FROM alliance_members WHERE alliance_id = $1 AND commander_id = $2', [id, targetCommanderId]);

        if (memberResult.rows.length > 0 && allianceResult.rows.length > 0) {
            const alliance = allianceResult.rows[0];
            await sendAllianceMail(targetCommanderId, memberResult.rows[0].commander_coord,
                'Aus der Allianz entfernt', // LOCALIZE
                `Du wurdest aus der Allianz "${alliance.name}" [${alliance.tag}] entfernt.`); // LOCALIZE
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] members/:id/kick Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// ADMIN-CHEATS für Allianzen — nur für ADMIN_COMMANDER_IDS, per
// display_id (der unveränderlichen "26080901001"-artigen ID) statt der
// internen Datenbank-ID adressiert, damit die Cheatcodes exakt die ID
// nutzen können, die auch im Spiel sichtbar ist.
// =========================================================
async function getAllianceByDisplayId(displayId) {
    const result = await pool.query('SELECT * FROM alliances WHERE display_id = $1', [displayId]);
    return result.rows.length > 0 ? result.rows[0] : null;
}

app.put('/alliances/admin/:displayId/rename', async (req, res) => {
    const { requesterCommanderId, newName } = req.body;
    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen das.' });
    if (!newName || newName.length < 6 || newName.length > 30)
        return res.status(400).json({ success: false, error: 'Name muss 6-30 Zeichen haben' });

    try {
        const alliance = await getAllianceByDisplayId(req.params.displayId);
        if (!alliance) return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });

        await pool.query('UPDATE alliances SET name = $1 WHERE id = $2', [newName.trim(), alliance.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] admin/rename Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/alliances/admin/:displayId/retag', async (req, res) => {
    const { requesterCommanderId, newTag } = req.body;
    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen das.' });
    if (!newTag || newTag.length < 3 || newTag.length > 6)
        return res.status(400).json({ success: false, error: 'Tag muss 3-6 Zeichen haben' });

    try {
        const alliance = await getAllianceByDisplayId(req.params.displayId);
        if (!alliance) return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });

        const tagTaken = await pool.query('SELECT id FROM alliances WHERE tag = $1 AND id != $2', [newTag.trim().toUpperCase(), alliance.id]);
        if (tagTaken.rows.length > 0)
            return res.status(400).json({ success: false, error: 'Dieses Tag ist bereits vergeben.' });

        await pool.query('UPDATE alliances SET tag = $1 WHERE id = $2', [newTag.trim().toUpperCase(), alliance.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] admin/retag Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/alliances/admin/:displayId/redescribe', async (req, res) => {
    const { requesterCommanderId, newDescription } = req.body;
    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen das.' });
    if ((newDescription || '').length > 1000)
        return res.status(400).json({ success: false, error: 'Beschreibung zu lang (max. 1000 Zeichen)' });

    try {
        const alliance = await getAllianceByDisplayId(req.params.displayId);
        if (!alliance) return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });

        await pool.query('UPDATE alliances SET description = $1 WHERE id = $2', [newDescription || '', alliance.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] admin/redescribe Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Alle Mitglieder außer dem Gründer entfernen — jeder Entfernte bekommt
// dieselbe "Allianz verlassen"-Mail wie beim normalen Austritt.
app.post('/alliances/admin/:displayId/kick-everyone', async (req, res) => {
    const { requesterCommanderId } = req.body;
    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen das.' });

    try {
        const alliance = await getAllianceByDisplayId(req.params.displayId);
        if (!alliance) return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });

        const membersToKick = await pool.query(
            "SELECT * FROM alliance_members WHERE alliance_id = $1 AND role != 'founder'",
            [alliance.id]
        );

        await pool.query("DELETE FROM alliance_members WHERE alliance_id = $1 AND role != 'founder'", [alliance.id]);

        for (const member of membersToKick.rows) {
            await sendAllianceMail(member.commander_id, member.commander_coord,
                'Allianz verlassen', // LOCALIZE
                `Du wurdest aus der Allianz "${alliance.name}" [${alliance.tag}] entfernt.`); // LOCALIZE
        }

        res.json({ success: true, kickedCount: membersToKick.rows.length });
    } catch (error) {
        console.error('[Server] admin/kick-everyone Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Allianz komplett auflösen — Gründer bekommt eine Mail, alle
// Mitgliedschaften werden per ON DELETE CASCADE automatisch mit entfernt.
app.delete('/alliances/admin/:displayId', async (req, res) => {
    const { requesterCommanderId } = req.body;
    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen das.' });

    try {
        const alliance = await getAllianceByDisplayId(req.params.displayId);
        if (!alliance) return res.status(404).json({ success: false, error: 'Allianz nicht gefunden' });

        const founderResult = await pool.query(
            "SELECT * FROM alliance_members WHERE alliance_id = $1 AND role = 'founder'",
            [alliance.id]
        );

        await pool.query('DELETE FROM alliances WHERE id = $1', [alliance.id]); // CASCADE entfernt Mitgliedschaften mit

        if (founderResult.rows.length > 0) {
            const founder = founderResult.rows[0];
            await sendAllianceMail(founder.commander_id, founder.commander_coord,
                'Allianz aufgelöst', // LOCALIZE
                `Die Allianz mit der ID ${req.params.displayId} wurde heute aufgelöst.`); // LOCALIZE
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] admin/delete Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// Satzung/Gründung
// -------------------------------------------------------
app.post('/alliances/charter', async (req, res) => {
    const { founderCommanderId, founderName, founderCoord, founderGalaxyId, name, tag, logoId, description,
            placeholder01, placeholder02, placeholder03 } = req.body;

    if (!founderCommanderId || !name || !tag)
        return res.status(400).json({ success: false, error: 'Fehlende Pflichtfelder' });
    if (name.length < 6 || name.length > 30) return res.status(400).json({ success: false, error: 'Name muss 6-30 Zeichen haben' });
    if (tag.length < 3 || tag.length > 6) return res.status(400).json({ success: false, error: 'Tag muss 3-6 Zeichen haben' });
    if ((description || '').length > 1000) return res.status(400).json({ success: false, error: 'Beschreibung zu lang (max. 1000 Zeichen)' });
    if ((logoId || 0) === 0 && !ADMIN_COMMANDER_IDS.includes(founderCommanderId))
        return res.status(403).json({ success: false, error: 'Dieses Logo ist Admin-Accounts vorbehalten.' });

    try {
        const existing = await getAllianceIdForCommander(founderCommanderId);
        if (existing)
            return res.status(400).json({ success: false, error: 'Du bist bereits Mitglied einer Allianz.' });

        const tagTaken = await pool.query('SELECT id FROM alliances WHERE tag = $1', [tag]);
        if (tagTaken.rows.length > 0)
            return res.status(400).json({ success: false, error: 'Dieses Allianz-Tag ist bereits vergeben.' });

        // Alpha: 1 Unterschrift reicht (später konfigurierbar auf 10)
        const requiredSignatures = 1;

        const result = await pool.query(
            `INSERT INTO alliance_charters
                (founder_commander_id, founder_name, founder_coord, founder_galaxy_id, name, tag, logo_id, description,
                 placeholder_01, placeholder_02, placeholder_03, required_signatures)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [founderCommanderId, founderName || 'Unbekannt', founderCoord || null, founderGalaxyId || 1,
             name.trim(), tag.trim().toUpperCase(),
             logoId || 0, description || '', placeholder01 || '', placeholder02 || '', placeholder03 || '',
             requiredSignatures]
        );
        res.json({ success: true, charter: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliances/charter POST Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Entwurf ansehen — wird auch fuers Teilen im Chat gebraucht (Klick auf
// "Satzung ansehen" in einer Chat-Nachricht ruft das hier auf)
app.get('/alliances/charter/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        const charterResult = await pool.query('SELECT * FROM alliance_charters WHERE id = $1', [id]);
        if (charterResult.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Satzung nicht gefunden' });

        const sigResult = await pool.query(
            'SELECT * FROM alliance_charter_signatures WHERE charter_id = $1 ORDER BY signed_at ASC',
            [id]
        );
        res.json({ success: true, charter: charterResult.rows[0], signatures: sigResult.rows });
    } catch (error) {
        console.error('[Server] alliances/charter/:id GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliances/charter/:id/sign', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { commanderId, commanderName, commanderCoord } = req.body;
    if (!id || !commanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        const charterResult = await pool.query('SELECT * FROM alliance_charters WHERE id = $1', [id]);
        if (charterResult.rows.length === 0)
            return res.status(404).json({ success: false, error: 'Satzung nicht gefunden' });
        const charter = charterResult.rows[0];

        if (charter.status !== 'pending')
            return res.status(400).json({ success: false, error: 'Diese Satzung ist nicht mehr offen.' });
        if (new Date(charter.expires_at) < new Date())
            return res.status(400).json({ success: false, error: 'Diese Satzung ist abgelaufen.' });

        const existingAlliance = await getAllianceIdForCommander(commanderId);
        if (existingAlliance)
            return res.status(400).json({ success: false, error: 'Du bist bereits Mitglied einer Allianz. Erst austreten.' });

        // Unterschrift eintragen (UNIQUE-Constraint verhindert doppelte Unterschrift automatisch)
        try {
            await pool.query(
                'INSERT INTO alliance_charter_signatures (charter_id, signer_commander_id, signer_name, signer_coord) VALUES ($1, $2, $3, $4)',
                [id, commanderId, commanderName || 'Unbekannt', commanderCoord || null]
            );
        } catch (dupeError) {
            return res.status(400).json({ success: false, error: 'Du hast bereits unterschrieben.' });
        }

        const sigCountResult = await pool.query('SELECT COUNT(*) AS cnt FROM alliance_charter_signatures WHERE charter_id = $1', [id]);
        const sigCount = parseInt(sigCountResult.rows[0].cnt, 10);

        if (sigCount < charter.required_signatures) {
            return res.json({ success: true, finalized: false, signatureCount: sigCount, required: charter.required_signatures });
        }

        // Genug Unterschriften -> Allianz jetzt wirklich erzeugen, inkl.
        // unveränderlicher display_id (Datum + Galaxie + fortlaufende Nummer)
        const displayId = await generateAllianceDisplayId(charter.founder_galaxy_id);

        const allianceResult = await pool.query(
            `INSERT INTO alliances (display_id, name, tag, logo_id, description, placeholder_01, placeholder_02, placeholder_03, founder_commander_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [displayId, charter.name, charter.tag, charter.logo_id, charter.description,
             charter.placeholder_01, charter.placeholder_02, charter.placeholder_03, charter.founder_commander_id]
        );
        const newAlliance = allianceResult.rows[0];

        // NEU (Phase R1): Die 5 Start-Ränge anlegen, BEVOR irgendjemand
        // eingetragen wird — sonst gäbe es kurzzeitig Mitglieder ohne
        // gültigen rank_id.
        const rankIds = await createDefaultAllianceRanks(newAlliance.id);

        // Gruender als Mitglied eintragen
        await pool.query(
            'INSERT INTO alliance_members (alliance_id, commander_id, commander_name, commander_coord, role, rank_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [newAlliance.id, charter.founder_commander_id, charter.founder_name, charter.founder_coord, 'founder', rankIds['Gründer']]
        );

        // Alle Unterzeichner als Mitglieder eintragen
        const signatures = await pool.query('SELECT * FROM alliance_charter_signatures WHERE charter_id = $1', [id]);
        for (const sig of signatures.rows) {
            await pool.query(
                'INSERT INTO alliance_members (alliance_id, commander_id, commander_name, commander_coord, role, rank_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (commander_id) DO NOTHING',
                [newAlliance.id, sig.signer_commander_id, sig.signer_name, sig.signer_coord, 'member', rankIds['Mitglied']]
            );
        }

        // Gründungs-Mail an ALLE Beteiligten (Gründer + Unterzeichner)
        const foundedSubject = 'Allianz gegründet!'; // LOCALIZE
        const foundedBody = `Die Allianz "${newAlliance.name}" [${newAlliance.tag}] (ID ${displayId}) wurde erfolgreich gegründet!`; // LOCALIZE
        await sendAllianceMail(charter.founder_commander_id, charter.founder_coord, foundedSubject, foundedBody);
        for (const sig of signatures.rows) {
            await sendAllianceMail(sig.signer_commander_id, sig.signer_coord, foundedSubject, foundedBody);
        }

        await pool.query(
            "UPDATE alliance_charters SET status = 'finalized', resulting_alliance_id = $1 WHERE id = $2",
            [newAlliance.id, id]
        );

        res.json({ success: true, finalized: true, alliance: newAlliance });
    } catch (error) {
        console.error('[Server] alliances/charter/:id/sign Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// SPIELER-BEZIEHUNGEN (RelationshipManager-Kern)
// =========================================================

app.get('/relationships/:commanderId', async (req, res) => {
    const commanderId = parseInt(req.params.commanderId, 10);
    const requesterId = parseInt(req.query.requesterId, 10);
    if (!commanderId) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    // FIX (21.08.): War komplett ungeschützt — JEDER konnte die komplette
    // Beziehungsliste (wer mit wem befreundet/im Krieg ist) JEDES
    // beliebigen Commanders abrufen, ohne jede Prüfung. Gleiches
    // Schutzniveau wie /commander/:id/colonies jetzt: eigene Liste immer
    // einsehbar, sonst nur bei Freundschaft/gleicher oder verbündeter Allianz.
    if (!requesterId)
        return res.status(400).json({ success: false, error: 'Fehlender requesterId-Parameter' });

    const authorized = await isAuthorizedToViewCommanderData(requesterId, commanderId);
    if (!authorized)
        return res.status(403).json({ success: false, error: 'Dir ist kein Einblick in die Beziehungen dieses Commanders gestattet.' });

    try {
        const result = await pool.query(
            'SELECT * FROM player_relationships WHERE commander_id_a = $1 OR commander_id_b = $1 ORDER BY established_at DESC',
            [commanderId]
        );
        res.json({ success: true, relationships: result.rows });
    } catch (error) {
        console.error('[Server] relationships GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/relationships/friend-request', async (req, res) => {
    const { commanderId, targetCommanderId } = req.body;
    if (!commanderId || !targetCommanderId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    if (commanderId === targetCommanderId)
        return res.status(400).json({ success: false, error: 'Nicht mit sich selbst befreundbar.' });

    const [a, b] = orderIds(commanderId, targetCommanderId);

    try {
        const result = await pool.query(
            `INSERT INTO player_relationships (commander_id_a, commander_id_b, status, requested_by)
             VALUES ($1, $2, 'friend_request_pending', $3)
             ON CONFLICT (commander_id_a, commander_id_b)
             DO UPDATE SET status = 'friend_request_pending', requested_by = $3
             WHERE player_relationships.status = 'neutral'
             RETURNING *`,
            [a, b, commanderId]
        );
        if (result.rows.length === 0)
            return res.status(400).json({ success: false, error: 'Beziehung ist nicht neutral, Anfrage nicht möglich.' });
        res.json({ success: true, relationship: result.rows[0] });
    } catch (error) {
        console.error('[Server] friend-request Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/relationships/friend-request/:id/accept', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { commanderId } = req.body;
    if (!id || !commanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        const result = await pool.query(
            `UPDATE player_relationships SET status = 'friend', established_at = now(),
                expires_at = now() + interval '30 days'
             WHERE id = $1 AND status = 'friend_request_pending' AND requested_by != $2
             RETURNING *`,
            [id, commanderId]
        );
        if (result.rows.length === 0)
            return res.status(400).json({ success: false, error: 'Anfrage nicht gefunden oder nicht annehmbar.' });
        res.json({ success: true, relationship: result.rows[0] });
    } catch (error) {
        console.error('[Server] friend-request/accept Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/relationships/friend-request/:id/decline', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        await pool.query("UPDATE player_relationships SET status = 'neutral' WHERE id = $1 AND status = 'friend_request_pending'", [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] friend-request/decline Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Freundschaft jederzeit einseitig kündbar -> sofort zurück zu neutral
app.post('/relationships/end-friendship', async (req, res) => {
    const { commanderId, targetCommanderId } = req.body;
    if (!commanderId || !targetCommanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    const [a, b] = orderIds(commanderId, targetCommanderId);

    try {
        await pool.query(
            "UPDATE player_relationships SET status = 'neutral' WHERE commander_id_a = $1 AND commander_id_b = $2 AND status = 'friend'",
            [a, b]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('[Server] end-friendship Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

const MAX_SIMULTANEOUS_WARS = 3;

app.post('/relationships/declare-war', async (req, res) => {
    const { commanderId, targetCommanderId } = req.body;
    if (!commanderId || !targetCommanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    if (commanderId === targetCommanderId) return res.status(400).json({ success: false, error: 'Krieg gegen sich selbst nicht möglich.' });

    const [a, b] = orderIds(commanderId, targetCommanderId);

    try {
        const warCountResult = await pool.query(
            "SELECT COUNT(*) AS cnt FROM player_relationships WHERE (commander_id_a = $1 OR commander_id_b = $1) AND status = 'war'",
            [commanderId]
        );
        if (parseInt(warCountResult.rows[0].cnt, 10) >= MAX_SIMULTANEOUS_WARS)
            return res.status(400).json({ success: false, error: `Maximal ${MAX_SIMULTANEOUS_WARS} gleichzeitige Kriege erlaubt.` });

        const existing = await pool.query(
            'SELECT * FROM player_relationships WHERE commander_id_a = $1 AND commander_id_b = $2',
            [a, b]
        );
        if (existing.rows.length > 0) {
            const rel = existing.rows[0];
            if (rel.status === 'friend')
                return res.status(400).json({ success: false, error: 'Erst Freundschaft kündigen, bevor Krieg erklärt werden kann.' });
            if (rel.status === 'war')
                return res.status(400).json({ success: false, error: 'Bereits im Krieg.' });
            if (rel.peace_cooldown_until && new Date(rel.peace_cooldown_until) > new Date())
                return res.status(400).json({ success: false, error: 'Friedens-Cooldown noch aktiv, kein erneuter Krieg möglich.' });
        }

        const result = await pool.query(
            `INSERT INTO player_relationships (commander_id_a, commander_id_b, status, requested_by, established_at)
             VALUES ($1, $2, 'war', $3, now())
             ON CONFLICT (commander_id_a, commander_id_b)
             DO UPDATE SET status = 'war', requested_by = $3, established_at = now(), expires_at = NULL
             RETURNING *`,
            [a, b, commanderId]
        );
        res.json({ success: true, relationship: result.rows[0] });
    } catch (error) {
        console.error('[Server] declare-war Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Alpha-Vereinfachung: sofortiger, einseitig auslösbarer Frieden (kein
// Tribut-System, keine Zustimmung der Gegenseite noetig) — spaeter
// ausbaubar zu einem echten Angebot/Annahme-Fluss.
app.post('/relationships/declare-peace', async (req, res) => {
    const { commanderId, targetCommanderId } = req.body;
    if (!commanderId || !targetCommanderId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    const [a, b] = orderIds(commanderId, targetCommanderId);

    try {
        const result = await pool.query(
            `UPDATE player_relationships
             SET status = 'neutral', peace_cooldown_until = now() + interval '24 hours', expires_at = NULL
             WHERE commander_id_a = $1 AND commander_id_b = $2 AND status = 'war'
             RETURNING *`,
            [a, b]
        );
        if (result.rows.length === 0)
            return res.status(400).json({ success: false, error: 'Kein aktiver Krieg zwischen diesen Commandern.' });
        res.json({ success: true, relationship: result.rows[0] });
    } catch (error) {
        console.error('[Server] declare-peace Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// ALLIANZ-BEZIEHUNGEN (Krieg zwischen zwei Allianzen)
// =========================================================
app.get('/alliance-relationships/:allianceId', async (req, res) => {
    const allianceId = parseInt(req.params.allianceId, 10);
    if (!allianceId) return res.status(400).json({ success: false, error: 'Ungueltige ID' });

    try {
        const result = await pool.query(
            'SELECT * FROM alliance_relationships WHERE alliance_id_a = $1 OR alliance_id_b = $1',
            [allianceId]
        );
        res.json({ success: true, relationships: result.rows });
    } catch (error) {
        console.error('[Server] alliance-relationships GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliance-relationships/declare-war', async (req, res) => {
    const { allianceId, targetAllianceId } = req.body;
    if (!allianceId || !targetAllianceId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    const [a, b] = orderIds(allianceId, targetAllianceId);

    try {
        const result = await pool.query(
            `INSERT INTO alliance_relationships (alliance_id_a, alliance_id_b, status)
             VALUES ($1, $2, 'war')
             ON CONFLICT (alliance_id_a, alliance_id_b) DO UPDATE SET status = 'war', established_at = now()
             RETURNING *`,
            [a, b]
        );
        res.json({ success: true, relationship: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliance-relationships/declare-war Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliance-relationships/declare-peace', async (req, res) => {
    const { allianceId, targetAllianceId } = req.body;
    if (!allianceId || !targetAllianceId) return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    const [a, b] = orderIds(allianceId, targetAllianceId);

    try {
        const result = await pool.query(
            `UPDATE alliance_relationships SET status = 'neutral', established_at = now()
             WHERE alliance_id_a = $1 AND alliance_id_b = $2 RETURNING *`,
            [a, b]
        );
        res.json({ success: true, relationship: result.rows[0] || null });
    } catch (error) {
        console.error('[Server] alliance-relationships/declare-peace Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// NEU (21.08., Phase 3): 'ally' (Verbündet) und 'nap' (Nicht-Angriffs-
// Pakt) — anders als 'war' brauchen beide eine Zustimmung der jeweils
// ANDEREN Seite, sonst könnte eine Allianz der anderen einfach eine
// Verpflichtung aufzwingen. Zwei generische Endpunkte statt vier fast
// identischer (propose-ally/accept-ally/propose-nap/accept-nap), gleiches
// Grundprinzip wie bei den Spieler-Freundschaftsanfragen
// (friend_request_pending -> friend).
//
// Ablauf: propose -> Status "{type}_pending", requested_by = Antragsteller.
// respond(accept=true) -> Status wird zu "{type}", expires_at = +30 Tage
// (Ablauf wird erst in Phase 4 tatsächlich GEPRÜFT, Feld wird aber schon
// jetzt gesetzt, gleiches Vorgehen wie seinerzeit bei Spieler-Freundschaften).
// respond(accept=false) -> zurück auf "neutral".
//
// Nur der GRÜNDER der anfragenden/antwortenden Allianz darf das auslösen
// (gleiche Rollen-Prüfung wie bei PUT /alliances/:id/edit).
// -------------------------------------------------------
// UMGESTELLT (22.08., Phase R2): prüft jetzt über das neue Rang-System
// (is_founder_rank), NICHT mehr über das alte role-Textfeld — das bleibt
// nur noch als Anzeige-Info bestehen ("Gründer"/"Mitglied" in der
// Mitgliederliste), ist aber keine Rechte-Quelle mehr. Name unverändert,
// damit keine der verbleibenden Aufrufstellen geändert werden muss.
async function isAllianceFounder(commanderId, allianceId) {
    const result = await pool.query(
        `SELECT r.is_founder_rank
         FROM alliance_members m
         JOIN alliance_ranks r ON r.id = m.rank_id
         WHERE m.alliance_id = $1 AND m.commander_id = $2`,
        [allianceId, commanderId]
    );
    return result.rows.length > 0 && result.rows[0].is_founder_rank === true;
}

// -------------------------------------------------------
// Rang-System — Grundlage für individuell konfigurierbare Ministerien
// (Phase R1). isAllianceFounder() oben wurde in Phase R2 bereits auf
// dieses System umgestellt. Die Endpunkte unten (Bewerbungen,
// Beziehungen) nutzen jetzt allianceHasPermission() statt
// isAllianceFounder(), damit diese Rechte an Offiziere/Ministerien
// delegierbar sind, nicht mehr fest an den Gründer gebunden.
// -------------------------------------------------------

// Whitelist statt freier String-Interpolation in SQL — auch wenn der
// Parameter nie aus req.body kommt (immer fest im Code vorgegeben),
// verhindert das Tippfehler UND SQL-Injection strukturell.
const ALLIANCE_PERMISSION_COLUMNS = [
    'can_manage_applications',
    'can_manage_relationships',
    'can_edit_alliance_info',
    'can_kick_members',
    'can_promote_members'
];

// Generische Rechte-Prüfung — EINE Stelle für alle künftigen
// Berechtigungs-Checks, egal wie viele individuelle Ränge eine
// Allianz später hat. is_founder_rank hat IMMER alle Rechte.
async function allianceHasPermission(commanderId, allianceId, permissionColumn) {
    if (!ALLIANCE_PERMISSION_COLUMNS.includes(permissionColumn))
        throw new Error(`Unbekannte Berechtigungsspalte: ${permissionColumn}`);

    const result = await pool.query(
        `SELECT r.is_founder_rank, r.${permissionColumn} AS has_permission
         FROM alliance_members m
         JOIN alliance_ranks r ON r.id = m.rank_id
         WHERE m.alliance_id = $1 AND m.commander_id = $2`,
        [allianceId, commanderId]
    );
    if (result.rows.length === 0) return false;
    return result.rows[0].is_founder_rank || result.rows[0].has_permission === true;
}

async function getFounderRankId(allianceId) {
    const result = await pool.query(
        'SELECT id FROM alliance_ranks WHERE alliance_id = $1 AND is_founder_rank = true LIMIT 1',
        [allianceId]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
}

async function getDefaultRankId(allianceId) {
    const result = await pool.query(
        'SELECT id FROM alliance_ranks WHERE alliance_id = $1 AND is_default_rank = true LIMIT 1',
        [allianceId]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
}

// NEU (22.08., Phase R3): liefert rank_order + is_founder_rank eines
// Mitglieds — Grundlage für die "nur nach unten"-Regel bei Befördern/
// Kicken (siehe /members/:commanderId/promote und /kick unten).
async function getMemberRankInfo(commanderId, allianceId) {
    const result = await pool.query(
        `SELECT m.rank_id, r.rank_order, r.is_founder_rank
         FROM alliance_members m JOIN alliance_ranks r ON r.id = m.rank_id
         WHERE m.alliance_id = $1 AND m.commander_id = $2`,
        [allianceId, commanderId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
}

// Wird EINMALIG bei Allianz-Gründung aufgerufen — legt die 5 Start-
// Ränge an. Alle Namen/Rechte danach frei änderbar (Phase R4, UI).
// Kriegsminister/Außenminister starten bewusst mit identischen Rechten
// (Beziehungen verwalten) — der Gründer differenziert das bei Bedarf
// selbst aus, das ist nur ein sinnvoller Startpunkt, keine feste Regel.
async function createDefaultAllianceRanks(allianceId) {
    const defaultRanks = [
        { name: 'Gründer', rank_order: 0, is_founder_rank: true, is_default_rank: false,
          can_manage_applications: true, can_manage_relationships: true, can_edit_alliance_info: true, can_kick_members: true, can_promote_members: true },
        { name: 'Kriegsminister', rank_order: 10, is_founder_rank: false, is_default_rank: false,
          can_manage_applications: false, can_manage_relationships: true, can_edit_alliance_info: false, can_kick_members: false, can_promote_members: false },
        { name: 'Außenminister', rank_order: 10, is_founder_rank: false, is_default_rank: false,
          can_manage_applications: false, can_manage_relationships: true, can_edit_alliance_info: false, can_kick_members: false, can_promote_members: false },
        { name: 'Innenminister', rank_order: 10, is_founder_rank: false, is_default_rank: false,
          can_manage_applications: true, can_manage_relationships: false, can_edit_alliance_info: false, can_kick_members: true, can_promote_members: true },
        { name: 'Mitglied', rank_order: 100, is_founder_rank: false, is_default_rank: true,
          can_manage_applications: false, can_manage_relationships: false, can_edit_alliance_info: false, can_kick_members: false, can_promote_members: false }
    ];

    const rankIds = {};
    for (const rank of defaultRanks) {
        const result = await pool.query(
            `INSERT INTO alliance_ranks
                (alliance_id, name, rank_order, is_founder_rank, is_default_rank,
                 can_manage_applications, can_manage_relationships, can_edit_alliance_info, can_kick_members, can_promote_members)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, name`,
            [allianceId, rank.name, rank.rank_order, rank.is_founder_rank, rank.is_default_rank,
             rank.can_manage_applications, rank.can_manage_relationships, rank.can_edit_alliance_info, rank.can_kick_members, rank.can_promote_members]
        );
        rankIds[rank.name] = result.rows[0].id;
    }
    return rankIds; // { "Gründer": 1, "Kriegsminister": 2, ... } — IDs, nicht Namen, für die Inserts unten
}

// -------------------------------------------------------
// NEU (22.08., Phase R2): Einmalige Migration für Allianzen, die VOR
// Phase R1 gegründet wurden — die haben weder alliance_ranks-Zeilen
// noch einen rank_id bei ihren Mitgliedern. Legt bei Bedarf die 5
// Start-Ränge nachträglich an und ordnet bestehende Mitglieder anhand
// des alten 'role'-Felds zu ('founder' -> Gründer-Rang, sonst ->
// Standard-Rang). Wird bei jedem Serverstart aufgerufen, aber
// idempotent (WHERE rank_id IS NULL findet beim zweiten Mal nichts mehr).
// -------------------------------------------------------
async function backfillAllianceRanks() {
    try {
        const alliancesNeedingBackfill = await pool.query(
            `SELECT DISTINCT alliance_id FROM alliance_members WHERE rank_id IS NULL`
        );

        for (const row of alliancesNeedingBackfill.rows) {
            const allianceId = row.alliance_id;

            const existingRanks = await pool.query(
                'SELECT id, is_founder_rank, is_default_rank FROM alliance_ranks WHERE alliance_id = $1',
                [allianceId]
            );

            let founderRankId, defaultRankId;
            if (existingRanks.rows.length === 0) {
                const rankIds = await createDefaultAllianceRanks(allianceId);
                founderRankId = rankIds['Gründer'];
                defaultRankId = rankIds['Mitglied'];
            } else {
                founderRankId = existingRanks.rows.find(r => r.is_founder_rank)?.id;
                defaultRankId = existingRanks.rows.find(r => r.is_default_rank)?.id;
            }

            await pool.query(
                `UPDATE alliance_members SET rank_id = $1 WHERE alliance_id = $2 AND rank_id IS NULL AND role = 'founder'`,
                [founderRankId, allianceId]
            );
            await pool.query(
                `UPDATE alliance_members SET rank_id = $1 WHERE alliance_id = $2 AND rank_id IS NULL AND role != 'founder'`,
                [defaultRankId, allianceId]
            );
        }

        if (alliancesNeedingBackfill.rows.length > 0)
            console.log(`[Server] Allianz-Rang-Backfill: ${alliancesNeedingBackfill.rows.length} Allianz(en) migriert.`);
    } catch (e) {
        console.error('[Server] Allianz-Rang-Backfill Fehler:', e.message);
    }
}

app.post('/alliance-relationships/propose', async (req, res) => {
    const { allianceId, targetAllianceId, requesterCommanderId, type } = req.body;
    if (!allianceId || !targetAllianceId || !requesterCommanderId || !type)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });
    if (type !== 'ally' && type !== 'nap')
        return res.status(400).json({ success: false, error: "type muss 'ally' oder 'nap' sein" });
    if (allianceId === targetAllianceId)
        return res.status(400).json({ success: false, error: 'Nicht mit der eigenen Allianz möglich' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, allianceId, 'can_manage_relationships')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, Bündnisse vorzuschlagen.' });

        const [a, b] = orderIds(allianceId, targetAllianceId);
        const result = await pool.query(
            `INSERT INTO alliance_relationships (alliance_id_a, alliance_id_b, status, requested_by, established_at, expires_at)
             VALUES ($1, $2, $3, $4, now(), NULL)
             ON CONFLICT (alliance_id_a, alliance_id_b)
             DO UPDATE SET status = $3, requested_by = $4, established_at = now(), expires_at = NULL
             RETURNING *`,
            [a, b, `${type}_pending`, allianceId]
        );
        res.json({ success: true, relationship: result.rows[0] });
    } catch (error) {
        console.error('[Server] alliance-relationships/propose Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/alliance-relationships/respond', async (req, res) => {
    const { allianceId, targetAllianceId, requesterCommanderId, accept } = req.body;
    if (!allianceId || !targetAllianceId || !requesterCommanderId || accept === undefined)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        if (!(await allianceHasPermission(requesterCommanderId, allianceId, 'can_manage_relationships')))
            return res.status(403).json({ success: false, error: 'Keine Berechtigung, auf Bündnisanfragen zu antworten.' });

        const [a, b] = orderIds(allianceId, targetAllianceId);
        const existing = await pool.query(
            'SELECT * FROM alliance_relationships WHERE alliance_id_a = $1 AND alliance_id_b = $2',
            [a, b]
        );
        if (existing.rows.length === 0 || !existing.rows[0].status.endsWith('_pending'))
            return res.status(400).json({ success: false, error: 'Keine offene Anfrage gefunden.' });
        if (existing.rows[0].requested_by === allianceId)
            return res.status(400).json({ success: false, error: 'Eigene Anfrage kann nicht selbst beantwortet werden.' });

        const type = existing.rows[0].status.replace('_pending', '');

        if (accept) {
            const result = await pool.query(
                `UPDATE alliance_relationships
                 SET status = $3, established_at = now(), expires_at = now() + interval '30 days'
                 WHERE alliance_id_a = $1 AND alliance_id_b = $2 RETURNING *`,
                [a, b, type]
            );
            res.json({ success: true, relationship: result.rows[0] });
        } else {
            const result = await pool.query(
                `UPDATE alliance_relationships
                 SET status = 'neutral', requested_by = NULL, established_at = now(), expires_at = NULL
                 WHERE alliance_id_a = $1 AND alliance_id_b = $2 RETURNING *`,
                [a, b]
            );
            res.json({ success: true, relationship: result.rows[0] });
        }
    } catch (error) {
        console.error('[Server] alliance-relationships/respond Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
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
// -------------------------------------------------------
// Fehlerbericht als Mail an den Admin-Account ausliefern.
// Läuft über den Server (kein Client-Zugriff auf fremde Accounts
// möglich) — genau wie bei der Angriffs-Warnung.
// -------------------------------------------------------
const ADMIN_PLAYFAB_ID = '1405316AFCC3DEDE'; // TheVirgoDominion
const ADMIN_COMMANDER_IDS = [1000000]; // TheVirgoDominion — weitere Admin-Accounts hier einfach mit Komma ergänzen, z.B. [1000000, 1000007]

app.post('/reportBug', async (req, res) => {
    const { reporterName, reporterCommanderId, reportText } = req.body;
    if (!reportText)
        return res.status(400).json({ success: false, error: 'Kein Berichtstext' });

    try {
        const adminData = await playfabServer('/Server/GetUserData', {
            PlayFabId: ADMIN_PLAYFAB_ID,
            Keys: ['commander_data']
        });
        if (!adminData.Data?.['commander_data'])
            return res.status(404).json({ success: false, error: 'Admin-Account nicht gefunden' });

        const adminCommander = JSON.parse(adminData.Data['commander_data'].Value);
        if (!adminCommander.inbox) adminCommander.inbox = [];

        // Auf eine vernünftige Länge begrenzen, damit commander_data nicht
        // durch einen einzelnen sehr langen Bericht unnötig aufgebläht wird
        const body = reportText.length > 2000 ? reportText.substring(0, 2000) + '\n[...gekürzt]' : reportText;

        const mailSeq = await getNextMailSeq();
        adminCommander.inbox.push({
            mailId: `M-${adminCommander.commanderId}-${mailSeq}`,
            category: 0, // System
            subject: `Fehlerbericht von ${reporterName || 'Unbekannt'} (#${reporterCommanderId || '?'})`,
            body: body,
            senderName: 'Fehlerbericht-System',
            senderId: 0,
            isRead: false,
            isFavorite: false,
            timestamp: formatTimestamp(new Date()),
            reportId: ''
        });

        await playfabServer('/Server/UpdateUserData', {
            PlayFabId: ADMIN_PLAYFAB_ID,
            Data: { 'commander_data': JSON.stringify(adminCommander) },
            Permission: 'Private'
        });

        res.json({ success: true });
    } catch (error) {
        console.error('[Server] reportBug Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// Rechtstexte — GET ist komplett offen (auch ohne Login lesbar,
// absichtlich, siehe Kommentar bei der Tabellen-Erstellung). PUT ist
// nur für Admin-Accounts, adressiert über den Text-Key (aktuell:
// "spielregeln", "agb", "datenschutz").
//
// Rückgabeform bewusst als Objekt { key: {content, version}, ... }
// statt als Zeilen-Array — im Client so am einfachsten per Key
// abzufragen, ohne erst eine Liste durchsuchen zu müssen. Fehlt ein Key
// komplett (noch nie über PUT angelegt), taucht er hier einfach nicht
// auf — der Client zeigt dann seinen eigenen Platzhaltertext.
// -------------------------------------------------------
app.get('/legal-texts', async (req, res) => {
    try {
        const result = await pool.query('SELECT key, content, version, updated_at FROM legal_texts');
        const texts = {};
        for (const row of result.rows) {
            texts[row.key] = { content: row.content, version: row.version };
        }
        res.json({ success: true, texts });
    } catch (error) {
        console.error('[Server] legal-texts GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/legal-texts/:key', async (req, res) => {
    const { requesterCommanderId, content } = req.body;
    const key = req.params.key;

    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen Rechtstexte ändern.' });
    if (!key || typeof content !== 'string')
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        // WICHTIG: version wird NUR erhöht, wenn sich der Inhalt wirklich
        // ändert (IS DISTINCT FROM) — ein Admin, der denselben Text
        // versehentlich zweimal speichert, zwingt dadurch nicht alle
        // Spieler zu einer unnötigen erneuten Zustimmung.
        const result = await pool.query(
            `INSERT INTO legal_texts (key, content, version, updated_at)
             VALUES ($1, $2, 1, now())
             ON CONFLICT (key) DO UPDATE SET
                content = $2,
                version = CASE WHEN legal_texts.content IS DISTINCT FROM $2
                               THEN legal_texts.version + 1
                               ELSE legal_texts.version END,
                updated_at = now()
             RETURNING *`,
            [key, content]
        );
        res.json({ success: true, text: result.rows[0] });
    } catch (error) {
        console.error('[Server] legal-texts PUT Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// Support-Kontaktformular — POST ist offen (auch für nicht eingeloggte
// Spieler, siehe Kommentar bei der Tabellen-Erstellung). GET (Liste
// einsehen) ist nur für Admin-Accounts.
// -------------------------------------------------------
app.post('/supportMessage', async (req, res) => {
    const { senderCommanderId, senderName, senderEmail, message } = req.body;

    if (!message || !message.trim())
        return res.status(400).json({ success: false, error: 'Nachricht darf nicht leer sein.' });
    if (message.length > 2000)
        return res.status(400).json({ success: false, error: 'Nachricht zu lang (max. 2000 Zeichen).' });

    try {
        const result = await pool.query(
            `INSERT INTO support_messages (sender_commander_id, sender_name, sender_email, message)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [senderCommanderId || null, senderName || null, senderEmail || null, message.trim()]
        );
        res.json({ success: true, supportMessage: result.rows[0] });
    } catch (error) {
        console.error('[Server] supportMessage POST Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/supportMessages', async (req, res) => {
    const requesterCommanderId = parseInt(req.query.requesterCommanderId, 10);
    if (!ADMIN_COMMANDER_IDS.includes(requesterCommanderId))
        return res.status(403).json({ success: false, error: 'Nur Admin-Accounts dürfen Support-Nachrichten einsehen.' });

    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 300);
        const result = await pool.query(
            'SELECT * FROM support_messages ORDER BY is_read ASC, created_at DESC LIMIT $1',
            [limit]
        );
        res.json({ success: true, messages: result.rows });
    } catch (error) {
        console.error('[Server] supportMessages GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
// -------------------------------------------------------
// NEU (21.08.): Allianz-Punkte aggregieren — läuft am Ende jedes
// serverTick, NACHDEM alle Commander-Highscores in dieser Runde
// aktualisiert wurden. Eine einzige SQL-Aggregation statt einer
// JS-Schleife: Summe der total_points aller Mitglieder pro Allianz.
//
// FIX für den Bug "alle Allianzen werden in der Highscore ineinander
// angezeigt": Die alliances.points-Spalte existierte zwar schon
// (GET /alliances sortiert danach), wurde aber nirgends tatsächlich
// berechnet — alle Allianzen hatten denselben Standardwert, die
// Sortierung war dadurch bedeutungslos.
// -------------------------------------------------------
async function updateAllianceHighscore(log) {
    try {
        const result = await pool.query(`
            UPDATE alliances a
            SET points = COALESCE(sub.total, 0)
            FROM (
                SELECT m.alliance_id, SUM(h.total_points) AS total
                FROM alliance_members m
                JOIN commander_highscore h ON h.commander_id = m.commander_id
                GROUP BY m.alliance_id
            ) sub
            WHERE a.id = sub.alliance_id
            RETURNING a.id
        `);
        log.push(`Allianz-Highscore aktualisiert: ${result.rows.length} Allianzen`);
    } catch (e) {
        log.push(`Allianz-Highscore Fehler: ${e.message}`);
    }
}

// -------------------------------------------------------
// NEU (21.08.): Abgelaufene Freundschaften zurück auf 'neutral' setzen.
// expires_at wird schon seit Längerem beim Annehmen einer
// Freundschaftsanfrage gesetzt (+30 Tage), wurde aber nirgends geprüft —
// Freundschaften liefen dadurch faktisch für immer. Läuft bei jedem
// serverTick mit (alle 5 Minuten), Ablauf ist also spätestens 5 Minuten
// nach dem tatsächlichen Ablaufzeitpunkt wirksam.
// -------------------------------------------------------
async function expireOldFriendships(log) {
    try {
        const result = await pool.query(`
            UPDATE player_relationships
            SET status = 'neutral', expires_at = NULL
            WHERE status = 'friend' AND expires_at IS NOT NULL AND expires_at < now()
            RETURNING commander_id_a, commander_id_b
        `);
        if (result.rows.length > 0)
            log.push(`Freundschaften abgelaufen: ${result.rows.length}`);
    } catch (e) {
        log.push(`Freundschafts-Ablauf Fehler: ${e.message}`);
    }
}

// -------------------------------------------------------
// NEU (22.08.): Abgelaufene Allianz-Bewerbungen (24h ohne Reaktion)
// STILL löschen — BEWUSST KEINE MAIL, siehe Chat vom 22.08.: Ignorieren
// soll sich zwischenmenschlich anders anfühlen als aktives Ablehnen
// (das eine Mail bekommt, siehe /applications/:appId/reject).
// -------------------------------------------------------
async function expireOldApplications(log) {
    try {
        const result = await pool.query(`
            DELETE FROM alliance_applications
            WHERE expires_at < now()
            RETURNING id
        `);
        if (result.rows.length > 0)
            log.push(`Bewerbungen abgelaufen (still): ${result.rows.length}`);
    } catch (e) {
        log.push(`Bewerbungs-Ablauf Fehler: ${e.message}`);
    }
}

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
                const commanderPlanetsForHighscore = []; // NEU: für die Punkte-Berechnung unten gesammelt

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

                            // Echte verstrichene Zeit seit dem letzten Tick
                            // verwenden (statt fest "300") — falls der Server
                            // mal ausfällt oder ein Tick verpasst wird, wird
                            // trotzdem korrekt nachgerechnet. Fehlt der
                            // Zeitstempel (z.B. bei ganz neuen Planeten),
                            // wird "jetzt" als Startpunkt angenommen (keine
                            // rückwirkende Produktion für die Vergangenheit).
                            const lastTick = planet.lastProductionTickUtc
                                ? new Date(planet.lastProductionTickUtc)
                                : now;
                            const elapsedSeconds = Math.max(0, (now - lastTick) / 1000);

                            const updatedPlanet = produceResources(planet, elapsedSeconds, commander);
                            updatedPlanet.lastProductionTickUtc = now.toISOString();

                            await playfabServer('/Server/UpdateUserData', {
                                PlayFabId: playFabId,
                                Data: { [planetKey]: JSON.stringify(updatedPlanet) },
                                Permission: 'Private'
                            });

                            commanderPlanetsForHighscore.push(updatedPlanet);
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

                // Highscore aktualisieren — läuft IMMER, unabhängig von
                // "changed" (auch wenn sich diesen Tick nichts an
                // Ressourcen/Flotten geändert hat, soll die Punktzahl
                // trotzdem aktuell in der Liste stehen)
                await updateCommanderHighscore(commander, commanderPlanetsForHighscore, playFabId);

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

    // NEU: Allianz-Punkte + Freundschafts-Ablauf — laufen NACH der
    // Spieler-Schleife oben, damit die Allianz-Aggregation die in DIESEM
    // Tick frisch berechneten commander_highscore-Werte mitnimmt.
    await updateAllianceHighscore(log);
    await expireOldFriendships(log);
    await expireOldApplications(log);

    res.json({ success: true, log, timestamp: now.toISOString() });
}

app.post('/serverTick', serverTickHandler);
app.get('/serverTick', serverTickHandler);

// -------------------------------------------------------
// Ressourcenproduktion
// -------------------------------------------------------
// =========================================================
// GEBÄUDE-WIRTSCHAFTSKONFIGURATION
// MUSS manuell synchron mit den Unity-Assets gehalten werden
// (BuildingDefinition.cs) — es gibt keine automatische Übertragung.
// Nur Gebäude mit echten Werten sind eingetragen; alle anderen
// produzieren einfach nichts (result bleibt 0).
// =========================================================
const BUILDING_ECONOMY = {
    0: { // Kommandozentrale — feste Grundproduktion, wächst NICHT mit Stufe.
         // baseStorageCapacity treibt hier die Ress05-Kapazität an (kein
         // eigenes Gebäude für Ress05).
        productionEarly: [[10], [20], [50], [25], [1]],
        scalesWithLevel: false,
        tierGrowthFactors: [],
        tierStepCounts: [],
        baseStorageCapacity: 10
    },
    1: { // Ress01-Gebäude (Energie)
        productionEarly: [[0, 2, 4, 8, 10], [], [], [], []],
        scalesWithLevel: true,
        tierGrowthFactors: [1.535, 1.62, 1.7],
        tierStepCounts: [4, 4, 7],
        baseStorageCapacity: 1000
    },
    2: { // Ress02-Gebäude (Wasserstoff) — Produktionswerte noch offen,
         // hier vorerst leer bis sie feststehen (siehe Chat-Verlauf)
        productionEarly: [[], [], [], [], []],
        scalesWithLevel: true,
        tierGrowthFactors: [1.535, 1.62, 1.7],
        tierStepCounts: [4, 4, 7],
        baseStorageCapacity: 1000
    },
    3: { // Ress03-Gebäude (Metalle) — Produktionswerte noch offen, aber
         // WICHTIG: baseStorageCapacity muss schon jetzt gesetzt sein,
         // sonst deckelt der Server die Ressource bei jedem Tick auf 0
         // (siehe Bug-Fund im Chat: fehlender Eintrag hier hat Ress03/04
         // bei jedem Server-Tick auf 0 zurückgesetzt)
        productionEarly: [[], [], [], [], []],
        scalesWithLevel: true,
        tierGrowthFactors: [1.535, 1.62, 1.7],
        tierStepCounts: [4, 4, 7],
        baseStorageCapacity: 1000
    },
    4: { // Ress04-Gebäude (Werkzeuge) — Produktionswerte noch offen,
         // gleicher Kapazitäts-Fix wie bei Ress03
        productionEarly: [[], [], [], [], []],
        scalesWithLevel: true,
        tierGrowthFactors: [1.535, 1.62, 1.7],
        tierStepCounts: [4, 4, 7],
        baseStorageCapacity: 1000
    }
    // Weitere Gebäude (Werft, Labor, ...): noch nicht definiert
};

// Produktion PRO TICK (5 Sekunden) für ein Gebäude auf einer bestimmten
// Stufe — Portierung von BuildingDefinition.GetProduction() aus Unity.
// =========================================================
// COMMANDER-HIGHSCORE — Punkte-Formeln, 1:1 portiert aus
// CommanderWindowController.cs (RefreshScore/CalculateFleetScore/
// CalculateInfrastructureScore/CalculateResearchScore). MUSS synchron
// gehalten werden, falls sich die Formel im Client mal ändert.
// =========================================================
const HS_WARSHIP_POINTS = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];
const HS_SHIP_POINTS    = [1, 10, 100, 1000, 10000, 100000];

function hsCalcFleetScore(planets) {
    let score = 0;
    for (const planet of planets) {
        if (!planet) continue;
        const warships = planet.warships || [];
        const ships = planet.ships || [];
        for (let i = 0; i < warships.length && i < HS_WARSHIP_POINTS.length; i++)
            score += (warships[i] || 0) * HS_WARSHIP_POINTS[i];
        for (let i = 0; i < ships.length && i < HS_SHIP_POINTS.length; i++)
            score += (ships[i] || 0) * HS_SHIP_POINTS[i];
    }
    return score;
}

function hsCalcPlanetDevelopment(planet) {
    if (!planet || !planet.buildings) return 0;
    let points = 0;
    for (let i = 0; i < planet.buildings.length; i++) {
        const level = planet.buildings[i] || 0;
        let perLevel;
        if (i === 0) perLevel = 50;
        else if (i === 5 || i === 6) perLevel = 100;
        else perLevel = 10;
        points += level * perLevel;
    }
    return points;
}

function hsCalcInfrastructureScore(planets) {
    let score = 0;
    for (const planet of planets) score += hsCalcPlanetDevelopment(planet);
    return score;
}

function hsCalcResearchPoints(level) {
    if (!level || level <= 0) return 0;
    let total = 0;
    let pointsPerLevel = 10;
    for (let i = 1; i <= level; i++) {
        total += pointsPerLevel;
        pointsPerLevel *= 1.1;
    }
    return Math.round(total);
}

function hsCalcResearchScore(commander) {
    const levels = [
        commander.weapon01, commander.weapon02, commander.weapon03,
        commander.shield01, commander.shield02, commander.shield03,
        commander.engine01, commander.engine02, commander.engine03, commander.engine04,
        commander.ress01, commander.ress02, commander.ress03, commander.ress04, commander.ress05,
        commander.recycling, commander.reparatur,
        commander.terraforming, commander.verwaltung, commander.architektur,
        commander.ingenieurwesen, commander.wirtschaftslehre
    ];
    let score = 0;
    for (const lvl of levels) score += hsCalcResearchPoints(lvl);
    return score;
}

async function updateCommanderHighscore(commander, planets, playFabId) {
    try {
        const fleetPoints = hsCalcFleetScore(planets);
        const infraPoints = hsCalcInfrastructureScore(planets);
        const researchPoints = hsCalcResearchScore(commander);
        const totalPoints = fleetPoints + infraPoints + researchPoints;

        await pool.query(
            `INSERT INTO commander_highscore (commander_id, commander_name, avatar_index, playfab_id, total_points, fleet_points, infrastructure_points, research_points, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (commander_id) DO UPDATE SET
                commander_name = $2, avatar_index = $3, playfab_id = $4, total_points = $5, fleet_points = $6,
                infrastructure_points = $7, research_points = $8, updated_at = now()`,
            [commander.commanderId, commander.visibleName || 'Unbekannt', commander.avatarIndex || 0, playFabId || null,
             totalPoints, fleetPoints, infraPoints, researchPoints]
        );
    } catch (e) {
        console.error(`[Server] updateCommanderHighscore Fehler (${commander.commanderId}):`, e.message);
    }
}

// -------------------------------------------------------
// Selbst-Reparatur für verwaiste Planeten — behebt genau das Szenario
// vom 11.08.: öffentliche Daten zeigen einen Planeten als "mir gehörend",
// aber er fehlt in der privaten colonies-Liste (Race-Condition-Folge).
// Sicherheit: Der Server prüft ZWINGEND anhand der ÖFFENTLICHEN
// Systemdaten, ob der Anfragende wirklich der eingetragene Besitzer ist —
// niemand kann sich damit fremde Planeten "reparieren".
// -------------------------------------------------------
app.post('/planets/repair-ownership', async (req, res) => {
    const { commanderId, coord: rawCoord } = req.body;
    if (!commanderId || !rawCoord)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    // WICHTIG: Koordinate normalisieren (führende Nullen etc. entfernen),
    // BEVOR sie irgendwo gespeichert wird — sonst kann z.B. "1:1:1:05"
    // wörtlich in commander.colonies landen, obwohl der Rest des Spiels
    // Koordinaten immer aus reinen Ganzzahlen baut (nie mit führender
    // Null). Das ist eine zweite Absicherung zusätzlich zur Prüfung im
    // Unity-Client (PlanetRepairTool.cs) — falls dieser Endpunkt jemals
    // von woanders aus aufgerufen wird.
    const coordParts = rawCoord.split(':').map(p => parseInt(p, 10));
    if (coordParts.length !== 4 || coordParts.some(n => isNaN(n) || n < 0))
        return res.status(400).json({ success: false, error: 'Ungültiges Koordinatenformat.' });
    const coord = coordParts.join(':');

    try {
        const ownerInfo = await getPlanetOwnerInfo(coord);
        if (!ownerInfo || !ownerInfo.pfid)
            return res.status(404).json({ success: false, error: 'Planet nicht gefunden oder unbesiedelt.' });

        if (ownerInfo.ownerCommanderId !== commanderId)
            return res.status(403).json({ success: false, error: 'Dieser Planet gehört laut öffentlichen Daten nicht dir — keine Reparatur möglich.' });

        const data = await playfabServer('/Server/GetUserData', {
            PlayFabId: ownerInfo.pfid,
            Keys: ['commander_data']
        });
        if (!data.Data?.['commander_data'])
            return res.status(404).json({ success: false, error: 'Commander-Daten nicht gefunden.' });

        const commander = JSON.parse(data.Data['commander_data'].Value);
        if (!commander.colonies) commander.colonies = [];

        if (commander.colonies.includes(coord)) {
            return res.json({ success: true, repaired: false, message: 'War bereits korrekt eingetragen, keine Reparatur nötig.' });
        }

        commander.colonies.push(coord);

        await playfabServer('/Server/UpdateUserData', {
            PlayFabId: ownerInfo.pfid,
            Data: { 'commander_data': JSON.stringify(commander) },
            Permission: 'Private'
        });

        res.json({ success: true, repaired: true, message: `Planet ${coord} wurde wieder in deine Kolonie-Liste eingetragen.` });
    } catch (error) {
        console.error('[Server] planets/repair-ownership Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -------------------------------------------------------
// Prüft, ob "requesterId" Einblick in die Kolonie-Liste von "targetId"
// bekommen darf — persönliche Freundschaft ODER gemeinsame Allianz ODER
// verbündete Allianzen (Allianz-Freundschaft ist aktuell noch nicht
// setzbar, aber die Prüfung ist schon vorbereitet für später).
// -------------------------------------------------------
// UMBENANNT (21.08.): hieß vorher isAuthorizedToViewColonies — wird jetzt
// auch für /relationships/:commanderId genutzt, daher generischer Name.
// Gleiche Logik wie zuvor: eigene Daten immer einsehbar, sonst nur bei
// Freundschaft, gleicher Allianz oder verbündeten Allianzen.
async function isAuthorizedToViewCommanderData(requesterId, targetId) {
    if (requesterId === targetId) return true; // eigene Akte immer einsehbar

    const relResult = await pool.query(
        `SELECT status FROM player_relationships
         WHERE (commander_id_a = $1 AND commander_id_b = $2) OR (commander_id_a = $2 AND commander_id_b = $1)`,
        [requesterId, targetId]
    );
    if (relResult.rows.length > 0 && relResult.rows[0].status === 'friend') return true;

    const requesterAlliance = await getAllianceIdForCommander(requesterId);
    const targetAlliance = await getAllianceIdForCommander(targetId);
    if (!requesterAlliance || !targetAlliance) return false;

    if (requesterAlliance === targetAlliance) return true; // gleiche Allianz

    const [a, b] = orderIds(requesterAlliance, targetAlliance);
    const allyResult = await pool.query(
        'SELECT status FROM alliance_relationships WHERE alliance_id_a = $1 AND alliance_id_b = $2',
        [a, b]
    );
    return allyResult.rows.length > 0 && allyResult.rows[0].status === 'ally';
}

app.get('/commander/:commanderId/colonies', async (req, res) => {
    const targetId = parseInt(req.params.commanderId, 10);
    const requesterId = parseInt(req.query.requesterId, 10);
    if (!targetId || !requesterId)
        return res.status(400).json({ success: false, error: 'Fehlende Parameter' });

    try {
        const authorized = await isAuthorizedToViewCommanderData(requesterId, targetId);
        if (!authorized)
            return res.status(403).json({ success: false, error: 'Dir ist kein Einblick in die Akte dieses Commanders gestattet.' });

        const pfidResult = await pool.query('SELECT playfab_id FROM commander_highscore WHERE commander_id = $1', [targetId]);
        if (pfidResult.rows.length === 0 || !pfidResult.rows[0].playfab_id)
            return res.status(404).json({ success: false, error: 'Commander nicht gefunden.' });

        const data = await playfabServer('/Server/GetUserData', {
            PlayFabId: pfidResult.rows[0].playfab_id,
            Keys: ['commander_data']
        });
        if (!data.Data?.['commander_data'])
            return res.status(404).json({ success: false, error: 'Commander-Daten nicht gefunden.' });

        const commander = JSON.parse(data.Data['commander_data'].Value);
        res.json({
            success: true,
            colonies: commander.colonies || [],
            mainPlanetCoord: commander.mainPlanetCoord || ''
        });
    } catch (error) {
        console.error('[Server] commander/colonies GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/highscore/commanders', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const result = await pool.query(
            `SELECT h.*, a.tag AS alliance_tag, a.name AS alliance_name, a.id AS alliance_id
             FROM commander_highscore h
             LEFT JOIN alliance_members m ON m.commander_id = h.commander_id
             LEFT JOIN alliances a ON a.id = m.alliance_id
             ORDER BY h.total_points DESC LIMIT $1`,
            [limit]
        );
        res.json({ success: true, highscore: result.rows });
    } catch (error) {
        console.error('[Server] highscore/commanders GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEU: Einzelner Commander per ID — für das Chat-Kontextmenü ("Profil
// ansehen" bei einem Spielernamen). Bewusst vom Server geholt statt aus
// lokalen Chat-Nachrichtendaten zusammengebaut, weil Client-Daten
// manipulierbar/veraltet sein können — Punkte/Allianz-Zugehörigkeit
// müssen aus der verlässlichen Quelle kommen. Gleiche JOIN-Logik wie
// /highscore/commanders oben, nur auf einen einzelnen Commander gefiltert.
app.get('/highscore/commanders/:commanderId', async (req, res) => {
    try {
        const commanderId = parseInt(req.params.commanderId);
        if (!commanderId) {
            return res.status(400).json({ success: false, error: 'Ungültige commanderId' });
        }

        const result = await pool.query(
            `SELECT h.*, a.tag AS alliance_tag, a.name AS alliance_name, a.id AS alliance_id
             FROM commander_highscore h
             LEFT JOIN alliance_members m ON m.commander_id = h.commander_id
             LEFT JOIN alliances a ON a.id = m.alliance_id
             WHERE h.commander_id = $1`,
            [commanderId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Commander nicht gefunden' });
        }

        res.json({ success: true, commander: result.rows[0] });
    } catch (error) {
        console.error('[Server] highscore/commanders/:id GET Fehler:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Produktion PRO TICK (5 Sekunden) für ein Gebäude auf einer bestimmten
// Stufe — Portierung von BuildingDefinition.GetProduction() aus Unity.
function getProductionPerTick(buildingIndex, level) {
    const config = BUILDING_ECONOMY[buildingIndex];
    if (!config) return [0, 0, 0, 0, 0];

    const effectiveLevel = config.scalesWithLevel ? level : 1;
    const result = [0, 0, 0, 0, 0];

    for (let r = 0; r < 5; r++) {
        const early = config.productionEarly[r];
        if (!early || early.length === 0) { result[r] = 0; continue; }

        if (effectiveLevel <= early.length) {
            result[r] = early[effectiveLevel - 1];
            continue;
        }

        let val = early[early.length - 1];
        let tierIdx = 0;
        let stepsInTier = 0;
        for (let lvl = early.length + 1; lvl <= effectiveLevel; lvl++) {
            if (config.tierStepCounts.length > 0 &&
                tierIdx < config.tierStepCounts.length - 1 &&
                stepsInTier >= config.tierStepCounts[tierIdx]) {
                tierIdx++;
                stepsInTier = 0;
            }
            const factor = config.tierGrowthFactors.length > 0
                ? config.tierGrowthFactors[Math.min(tierIdx, config.tierGrowthFactors.length - 1)]
                : 1;
            val *= factor;
            stepsInTier++;
        }
        result[r] = val;
    }

    return result;
}

// Lagerkapazitäts-Sprungtabelle — identisch zur Unity-Logik
// (BuildingDefinition.GetStorageCapacity): wächst IMMER ab Stufe 1->2,
// unabhängig davon ob das Gebäude bei Stufe 0 oder 1 beginnt.
const CAPACITY_JUMPS = { 4: 3, 9: 5, 14: 8, 19: 12 };
function getCapacityMultiplier(level) {
    let mult = 1;
    for (let s = 2; s <= level; s++) {
        if (CAPACITY_JUMPS[s]) mult *= CAPACITY_JUMPS[s];
        else if (s === 20) mult *= 12;
        else mult *= 2;
    }
    return mult;
}
function getStorageCapacity(buildingIndex, level) {
    const config = BUILDING_ECONOMY[buildingIndex];
    if (!config) return 0;
    if (level <= 0) return config.baseStorageCapacity;
    return config.baseStorageCapacity * getCapacityMultiplier(level);
}

// Ressourcenproduktion für einen Planeten nachrechnen — läuft jetzt mit
// ECHTER verstrichener Zeit (nicht mehr fest "300"), damit auch bei
// Serverausfällen/verpassten Ticks sauber nachgerechnet wird. Jede
// Ressource hat ihre EIGENE Kapazität vom jeweils zugehörigen
// Ressourcen-Gebäude (Ress05: von der Kommandozentrale, da kein eigenes
// Gebäude existiert) — exakt wie im Unity-Client (PlanetProductionManager.cs).
// Ordnet einem Building-Index (1-4) die passende Rohstoff-Forschungsstufe
// des Commanders zu. Building-Index 0 (Kommandozentrale) und alles
// außerhalb 1-4 -> 0 (kein Bonus — Ress05/Kommandozentrale bewusst
// ausgenommen, siehe Absprache im Chat).
function getResearchLevelForBuildingIndex(buildingIndex, commander) {
    if (!commander) return 0;
    switch (buildingIndex) {
        case 1: return commander.ress01 || 0;
        case 2: return commander.ress02 || 0;
        case 3: return commander.ress03 || 0;
        case 4: return commander.ress04 || 0;
        default: return 0;
    }
}

function produceResources(planet, elapsedSeconds, commander) {
    const TICK_INTERVAL_SECONDS = 5; // muss mit Unity resourceTickInterval übereinstimmen
    const ticks = Math.floor(elapsedSeconds / TICK_INTERVAL_SECONDS);
    if (ticks <= 0) return planet;
    if (!planet.ressources) planet.ressources = [0, 0, 0, 0, 0];
    if (!planet.buildings) return planet;

    const caps = [0, 0, 0, 0, 0];
    for (let r = 1; r <= 4; r++) {
        const level = planet.buildings[r] || 0;
        caps[r - 1] = getStorageCapacity(r, level);
    }
    caps[4] = getStorageCapacity(0, planet.buildings[0] || 0);

    for (let i = 0; i < planet.buildings.length; i++) {
        const level = planet.buildings[i];
        if (!level || level <= 0) continue;

        const perTick = getProductionPerTick(i, level);

        // Rohstoff-Forschung: +1% Ertrag pro Stufe, NUR für Ress01-04-
        // Gebäude (Building-Index 1-4)
        const researchLevel = getResearchLevelForBuildingIndex(i, commander);
        const bonusMultiplier = researchLevel > 0 ? 1 + researchLevel * 0.01 : 1;

        for (let r = 0; r < 5; r++) {
            if (perTick[r] === 0) continue;
            planet.ressources[r] = Math.min(
                (planet.ressources[r] || 0) + (perTick[r] * bonusMultiplier) * ticks,
                caps[r]
            );
        }
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
