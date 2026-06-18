# Immo Dashboard – Supabase Einrichtung & Hosting

## 1) Supabase-Projekt anlegen

1. Auf https://supabase.com anmelden.
2. **New project** wählen.
3. Region: **EU Central (Frankfurt)** auswählen.
4. Projekt erstellen und warten, bis es bereit ist.

## 2) Auth aktivieren

1. Supabase links **Authentication → Providers** öffnen.
2. **Email** aktiv lassen.
3. Für schnelle Tests kann **Confirm email** deaktiviert werden; für echten Betrieb besser aktiv lassen.
4. Nach dem Hosting unter **Authentication → URL Configuration** die öffentliche App-Adresse als **Site URL** eintragen und ggf. unter **Redirect URLs** ergänzen.

## 3) Datenbank, RLS und Storage anlegen

1. In Supabase links **SQL Editor** öffnen.
2. **New query** klicken.
3. Inhalt aus `supabase-schema.sql` einfügen.
4. **Run** ausführen.

Dadurch werden angelegt:
- Tabellen `mieter` und `zahlungen`
- Row Level Security für eigene Daten je Nutzer
- privater Storage-Bucket `dokumente`
- Storage-Policies: Nutzer dürfen nur Dateien unter `<eigene-user-id>/...` lesen/schreiben
- Datei-Limit 5 MB und erlaubte PDF/Bild-MIME-Typen

## 4) Project URL + anon public key in `config.js` eintragen

Die Werte findest du in Supabase hier:

1. **Project Settings** öffnen.
2. **Data API** öffnen.
3. Kopieren:
   - **Project URL** → `SUPABASE_URL`
   - **Project API keys → anon public** → `SUPABASE_ANON_KEY`
4. In `config.js` eintragen:

```js
export const SUPABASE_URL = 'https://dein-projekt.supabase.co';
export const SUPABASE_ANON_KEY = 'dein-anon-public-key';
```

Wichtig: Der `anon public key` darf im Browser liegen. **Service role keys niemals in diese App eintragen.**

## 5) Lokal testen

Im Projektordner:

```bash
cd "/Users/moltbot/Dashboard Immo"
python3 -m http.server 8000
```

Dann öffnen:

```text
http://localhost:8000
```

Testablauf:
1. Konto erstellen oder anmelden.
2. Falls alte localStorage-Daten vorhanden sind, Import bestätigen.
3. Mieter anlegen/bearbeiten.
4. In anderem Browser/Gerät mit demselben Login anmelden → Daten müssen sichtbar sein.
5. Zweiten Test-Account anlegen → Daten des ersten Accounts dürfen nicht sichtbar sein.
6. Mietvertrag/Beleg hochladen und öffnen.
7. Browser-Konsole prüfen: keine Fehler.

## 6) Online hosten

Die App ist statisch und braucht keinen Build-Step. Geeignete Optionen:

### Option A: Netlify Drag & Drop

1. Projektordner bereithalten mit:
   - `index.html`
   - `style.css`
   - `app.js`
   - `config.js`
   - optional `supabase-schema.sql`, `README-SUPABASE.md`
2. Auf https://app.netlify.com gehen.
3. **Add new site → Deploy manually**.
4. Den Ordner bzw. die Dateien hineinziehen.
5. Netlify-URL öffnen und Login testen.

### Option B: GitHub Pages

1. Neues GitHub-Repository erstellen.
2. Dateien `index.html`, `style.css`, `app.js`, `config.js` committen.
3. Repository Settings → **Pages**.
4. Source: Branch `main`, Folder `/root`.
5. GitHub-Pages-URL öffnen.

### Option C: Vercel

1. Projekt in GitHub bereitstellen.
2. Vercel → **Add New Project**.
3. Repository importieren.
4. Framework Preset: **Other** / kein Build-Step.
5. Deploy.

## Datenschutz-Hinweise

- Supabase-Projekt wurde für EU Frankfurt vorgesehen.
- RLS verhindert, dass eingeloggte Nutzer fremde Zeilen lesen/schreiben.
- Dokumente liegen in einem privaten Bucket und werden nur über kurzlebige signierte URLs geöffnet.
- IBANs und Mieterdaten liegen trotzdem in einer Cloud-Datenbank. Zugriff auf Supabase-Admins und Projektmitglieder entsprechend begrenzen.
