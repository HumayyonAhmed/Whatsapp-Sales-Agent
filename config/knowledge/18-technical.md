# Technical Details

## What AquaFlow is, technically

AquaFlow is a **Progressive Web App (PWA)**. This means:

- It runs in a normal web browser (Chrome, Safari, Edge, Firefox) on
  desktop or mobile — no app store download needed for the Owner's main
  system.
- It can optionally be "added to home screen" on a phone for an app-like
  experience, while still just being a website underneath.
- It has **temporary offline capability** — recent actions can continue to
  work briefly during a short internet interruption.
- It requires internet periodically to **sync data with the backend
  (Supabase)** — it is not designed for extended, fully-offline use over
  long periods.

## Backend

AquaFlow's backend is built on **Supabase**, a cloud data platform. This is
where all business data (customers, deliveries, drivers, bottles,
subscriptions, payments) is stored and synced from every device/browser
using AquaFlow.

## Devices and access

- **Owner**: any desktop or mobile browser.
- **Delivery Boy (Rider)**: the rider mobile app, also browser-based.
- **Customer**: the customer portal, browser-based.

No specialized hardware or app store installation is required for any role.

## What the AI should NOT claim technically

- Do not describe specific integrations with other software/POS/accounting
  systems unless a team member confirms this is supported — if asked, say
  a team member will follow up with accurate integration details.
- Do not describe specific database architecture, API details, or
  infrastructure specifics beyond "built on Supabase" and the offline/sync
  behavior described above.
- Do not promise custom technical work (custom integrations, custom
  features, custom reports) — these require a team member's involvement,
  not an AI commitment.
