# Bobo

Bobo is a Jira-inspired, ultra-light project management studio centered on a Gantt chart.

It is designed for small LAN teams on Windows:

- double-click `run.bat` to start locally
- open the browser automatically at `http://localhost:4177`
- access from other devices on the same LAN through `http://<this-computer-ip>:4177`
- store project data in `data/projects.json`
- no database and no npm install required

## Run

Requires Node.js 18+.

```powershell
.\run.bat
```

Or:

```powershell
npm start
```

## Current Prototype Scope

- Gantt-first view with date axis and milestone markers
- system selector with rename, add, and empty-system deletion
- autosave after confirmed edits while keeping a manual save fallback
- system-level and project-level date markers in the Gantt date header
- vertical hierarchy: project -> requirement -> stage
- default stages: requirement clarification, effort estimate, feature development, technical test, business test
- fold and expand projects and requirements
- hover tooltip for stage details
- double-click stage bars to edit dates, assignee, hours, issue status, and notes
- add projects, requirements, stages, and milestones from the UI
- edit projects, requirements, and stages through a shared dialog
- delete projects, requirements, and stages from the dialog top-right with a confirmation prompt
- cascade deletion: deleting a project removes its requirements, stages, and project markers; deleting a requirement removes its stages
- select and visually pin a project without changing saved project order
- persist changes to local JSON
