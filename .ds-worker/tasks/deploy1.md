m: f
k: p
r: ~/Desktop/ai/claude/projects/johorstudio-livephoto-events
c: deploy/update.sh
o: .ds-worker/deploy-note.txt
t: git pull -q origin main && git log --oneline -1 && bash deploy/update.sh
## I
- write .ds-worker/deploy-note.txt: one line "deploy to m10 requested"
- do not change any other file
## A
1 .ds-worker/deploy-note.txt exists with that one line
2 test command exits 0 and prints UP
