# Community Forum App

An online platform for reporting community issues. Community members report problems (burst pipes, broken street lights, uncollected refuse…), community leaders respond and post progress updates, and everyone can follow each issue until it is fixed.

**Team:** Abonile Tengwa (Database Designer & Developer) · Sinesipho Sokoyi (System Analyst & Presenter)
**Stack:** HTML/CSS/JavaScript · Node.js + Express · MySQL 8.4 · **Schema version:** 1.0

## Project deliverables

| File | What it is |
|---|---|
| [docs/Community-Forum-Report.docx](docs/Community-Forum-Report.docx) (+ `.pdf`) | Full report: ERD, data dictionary, constraints, extension tables, UI, CRUD, comparison report, change management, SQL appendices |
| [docs/Community-Forum-Presentation.pptx](docs/Community-Forum-Presentation.pptx) | Presentation slides with speaker notes |
| [docs/Community-Forum-Installation-Manual.docx](docs/Community-Forum-Installation-Manual.docx) (+ `.pdf`) | How to install and run the app on another computer, and first use |
| [docs/erd/](docs/erd) | Conceptual and physical ERDs (PNG + SVG), generated from the live database |
| [db/schema.sql](db/schema.sql) · [docs/queries.sql](docs/queries.sql) | Complete creation script · reporting queries |

Regenerate everything with `npm run docs:build` (MySQL and the app must be running; needs `npm install` including dev tools, Microsoft Edge and Word). The screenshot tool creates its own sample data and deletes it afterwards.

## Problems it addresses

| Problem (from the project plan) | How the app solves it |
|---|---|
| No centralized reporting platform | One place to report issues, with category, area, location and photos |
| Poor communication | Comments between members and leaders on every issue; official leader updates |
| Delays in resolving issues | Leader dashboard: open, unassigned and oldest issues; "me too" votes show priority |
| Loss of records | Everything is stored in MySQL; deleting an account keeps the issues it reported |
| Difficulty tracking progress | Status workflow with a full timeline of who changed what and when |

## Roles

| Role | Can do |
|---|---|
| **Member** | Sign up, report issues (with up to 3 photos), edit/withdraw a report until a leader responds, vote "me too", comment, confirm a fix or reopen an issue |
| **Leader** | Everything a member can, plus: update status, priority and assignee for issues in **their areas**, post official updates, moderate comments, dashboard |
| **Admin** | Everything, in every area, plus: manage people (promote to leader, assign areas, deactivate, reset passwords, delete), areas and categories |

Issue status flow: **Reported → Acknowledged → In progress → Resolved → Closed** (or **Rejected** with a reason). When an issue is resolved, the reporter confirms it's fixed (→ Closed) or says it isn't (→ back to In progress).

## Setup

1. Install **Node.js (LTS)** and **MySQL Server 8.4** (see the MarkMind installation manual for step-by-step instructions; the steps are the same).
2. Copy `.env.example` to `.env` and set `DB_PASSWORD` and a random `SESSION_SECRET`.
3. In this folder:

   ```
   npm install --omit=dev
   npm run db:setup
   npm run admin:create -- "Your Name" you@example.com
   npm start
   ```

4. Open <http://localhost:3001> and log in with the email and the temporary password printed by `admin:create`. Choose your own password.
5. As admin: add the community's **areas** (Admin → Areas), check the **categories**, and once people have signed up, make leaders and tick the areas they look after (Admin → People).

## Commands

| Command | What it does |
|---|---|
| `npm start` | Starts the app at http://localhost:3001 |
| `npm run db:setup` | Creates the database or applies new migrations (never deletes data) |
| `npm run db:reset` | **Deletes** the database and creates an empty one |
| `npm run admin:create -- "Name" email` | Creates an administrator (or promotes an existing account) with a temporary password |
| `npm run admin:reset-password -- email` | Gives anyone a temporary password (e.g. the only admin forgot theirs) |
| `npm run db:check` | Checks `db/schema.sql` matches the database and that 23 integrity rules are enforced by MySQL (test rows are rolled back) |
| `npm run test:api` | 57 end-to-end tests as admin, leader and members (app must be running; all test data is removed afterwards) |
| `npm run db:inspect` | Lists every key, index and constraint in the live database |

## Database

9 tables (plus `schema_migrations`): `users`, `areas`, `categories`, `leader_areas`, `issues`, `issue_photos`, `issue_updates`, `comments`, `issue_votes`.

- Named constraints throughout: `fk_<table>_<target>`, `uq_<table>_<cols>`, `idx_<table>_<col>`, `chk_<table>_<rule>`.
- 11 CHECK constraints, e.g. a resolved/closed issue must have a `resolved_at` date and an open one must not; photos must be JPEG/PNG/WebP ≤ 2 MB.
- `ON DELETE RESTRICT` for areas and categories that have issues; `SET NULL` so issues, comments and updates survive when an account is deleted; `CASCADE` from an issue to its photos, updates, comments and votes.
- Photos are stored in the database (`MEDIUMBLOB`), so one backup contains everything.
- Full creation script: [db/schema.sql](db/schema.sql). Upgrades: [db/migrations/](db/migrations).

## Project structure

```
server.js              Express app, sessions, readable database errors
routes/                auth, reference (areas/categories), issues, comments, admin, stats
lib/                   account helpers, login/role middleware, issue rules (status workflow, photos)
db/                    schema.sql, migrations/, setup.js, pool.js
public/                Web pages: login, issues, issue, report, dashboard, admin, profile
tools/                 admin commands, schema comparison, constraint and API tests
```
