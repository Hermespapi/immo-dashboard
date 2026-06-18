# Immo Dashboard

Statisches Immo-Dashboard für Mieterdaten, Zahlungsstatus und Warnliste.

## Betrieb

Die App ist statisch und läuft ohne Build-Schritt. Sie wird über GitHub Pages bereitgestellt und nutzt Supabase für:

- Authentifizierung per E-Mail/Passwort
- Tabellen `mieter` und `zahlungen`
- optional privaten Storage-Bucket `dokumente` für Verträge/Belege

## Lokaler Start

```bash
python3 -m http.server 8000
```

Dann öffnen:

```text
http://localhost:8000/
```

## Supabase

Die Browser-App nutzt nur die öffentliche Supabase Project URL und den `anon public` Key aus `config.js`.

Wichtig: Niemals einen `service_role` Key in diese statische App eintragen.

Die Datenbank-Struktur liegt in `supabase-schema.sql`. Details stehen in `README-SUPABASE.md`.
