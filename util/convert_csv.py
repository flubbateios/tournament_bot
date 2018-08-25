import csv
import json
import sys
i = sys.argv[1]
o = sys.argv[2]

TEAM_NAME='Team Name'
DISCORD = 'Player %N% Discord'
IGN = 'Player %N% In-Game Name'

csvfile = open(i,'r',encoding='utf-8',newline='')
r = csv.reader(csvfile)
rows = []
for x in r:
    rows.append(x)
topRow = rows.pop(0)
teams = []
teamNameIndex = topRow.index(TEAM_NAME)
d = True
c = 1
while d:
    try:
        Di = topRow.index(DISCORD.replace('%N%',str(c)))
        Dn = topRow.index(IGN.replace('%N%',str(c)))
        teams.append([Di,Dn])
        c+=1
    except:
        d = False
out = []
c = 0
for x in rows:
    c+=1
    np = {'id':str(c),'players':[]}
    np['teamName'] = x[teamNameIndex]
    for y in teams:
        player = {'discordId':'','uberId':'','checkedIn':False}
        player['discordUsername'] = x[y[0]]
        player['displayName'] = x[y[1]]
        np['players'].append(player)
    out.append(np)
csvfile.close()
outjson = open(o,'w')
outjson.write(json.dumps(out))
outjson.close()
