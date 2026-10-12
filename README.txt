STUDENT PROJECT SHOWCASE — OFFLINE EDITION
==========================================

How to start
------------
1. Extract the full ZIP file to a folder. Do not open the website while it is still inside the ZIP.
2. Double-click LAUNCH_OFFLINE_PORTAL.bat.
3. If Windows asks which application to use, choose Microsoft Edge or Google Chrome.

You can also open Student_Project_Showcase_Offline.html directly.

What works without internet
---------------------------
- Public-style showcase of published projects
- Nine-school project monitoring dashboard
- New project submission
- Status, session, progress and trainer-feedback updates
- School-name editing
- JSON backup and restore
- School-specific handover files
- Merge of records from different computers
- CSV export

Important limitations
---------------------
- Each browser/computer stores its own copy. Changes do not automatically appear on another computer.
- Opening a MakeCode Arcade web share link still requires internet access.
- Browser data can be cleared. Export a JSON backup regularly.
- Keep all files in this folder together so the sample images continue to display.

Recommended workflow for nine schools
-------------------------------------
1. Give each school a copy of this extracted folder.
2. The trainer records the school's projects on its assigned computer.
3. From Schools & Backup, select the school and choose Export selected school.
4. Send the resulting JSON file to the programme coordinator using your approved transfer method.
5. On the master computer, choose Import a backup > Merge into this copy.
6. Repeat for all nine schools.
7. Export all data to create a new master backup.

Privacy
-------
Use team names or project codes only. Do not enter pupils' full names, personal email addresses,
photographs, contact details or other personal information.


STUDENT VOTING
--------------
1. Publish eligible projects in Monitor (only Published projects can receive new votes).
2. Supply each student with a unique anonymous code within their school, e.g. C1-023.
   Reuse that same code on every computer. Do not use names or email addresses.
3. Open Vote. Select school, code and the student's own team/project.
4. Choose another team's published project and click Save my vote.
5. Use Next student / clear code when sharing a computer.

One vote is stored per school + student code. Saving another choice replaces it.
Students cannot select their own team, including other projects with the same team name.
Codes rely on teacher supervision: this offline version has no authenticated accounts.
Students must have a team/project record before voting.

Ranked project cards and the voting results table appear together in Showcase > Featured student projects. Click a project title in the table to open its details. Cards show the rank and vote total, with the most voted projects first. Ties share a rank.
Export results CSV downloads aggregate project totals without student codes.
JSON backups contain anonymous codes and voting records for consolidation.
School handovers include that school's student votes, its projects and any project/school
records needed to preserve those votes. Repeated imports do not double-count votes.
When the same student votes on two devices, the most recent timestamp wins; keep device
clocks correct. Equal timestamp conflicts use a stable tie-break so import order does not matter.
Votes for projects no longer Published are retained in backups, but omitted from the published
results table. Deleting a project removes votes referencing that project or its own team.
Removing all projects or restoring sample data clears votes too.

UPDATING YOUR EXISTING COPY
--------------------------
Export all data from your old portal first. Extract this updated package, open the new HTML,
then import your old JSON backup using Merge. Existing project backups remain compatible.
Keep the assets folder beside the HTML; it contains all four sample images.
