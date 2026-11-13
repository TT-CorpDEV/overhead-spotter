#!/usr/bin/env python3
"""Builds a compact owner lookup from the FAA Releasable Aircraft database.

Input: the unzipped ReleasableAircraft folder (MASTER.txt, ACFTREF.txt, ENGINE.txt).
Output: faa/<first three hex digits>.json, each {icao_hex: record}, plus faa/meta.json.
Record: [tail, owner, owner type, city, state or country, registered (YYYYMMDD), expires,
         airworthiness class, airworthiness date, year built, model, engine, fleet size]
Street addresses are left out on purpose: the app shows city and state only.
"""
import csv, json, os, sys, collections, datetime

src, out = sys.argv[1], sys.argv[2]

def rows(name):
    path = next((os.path.join(src, f) for f in os.listdir(src) if f.upper() == name), None)
    if not path:
        sys.exit("missing " + name)
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
        rd = csv.reader(fh)
        head = [h.strip().upper() for h in next(rd)]
        for r in rd:
            yield {h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(head) if h}

REGTYPE = {"1": "Individual", "2": "Partnership", "3": "Corporation", "4": "Co-owned", "5": "Government",
           "7": "LLC", "8": "Non-citizen corporation", "9": "Non-citizen co-owned"}
CERT = {"1": "Standard", "2": "Limited", "3": "Restricted", "4": "Experimental", "5": "Provisional",
        "6": "Multiple", "7": "Primary", "8": "Special flight permit", "9": "Light sport"}
STD = {"N": "normal", "U": "utility", "A": "acrobatic", "T": "transport", "G": "glider", "B": "balloon", "C": "commuter", "O": "other"}
EXP = {"1": "research and development", "2": "amateur-built", "3": "exhibition", "4": "racing", "5": "crew training",
       "6": "market survey", "7": "kit-built", "8": "light-sport", "9": "unmanned"}

def cert(c):
    if not c:
        return ""
    base = CERT.get(c[0], "")
    sub = c[1:2]
    if c[0] == "1" and sub in STD:
        return base + ", " + STD[sub]
    if c[0] == "4" and sub in EXP:
        return base + ", " + EXP[sub]
    return base

def title(s):
    s = " ".join(s.split())
    return s.title() if s.isupper() and len(s) > 3 else s

models = {r["CODE"]: (r.get("MFR", ""), r.get("MODEL", "")) for r in rows("ACFTREF.TXT")}
engines = {r["CODE"]: (r.get("MFR", ""), r.get("MODEL", "")) for r in rows("ENGINE.TXT")}

recs, fleet = [], collections.Counter()
for r in rows("MASTER.TXT"):
    hx = r.get("MODE S CODE HEX", "").lower()
    if len(hx) != 6:
        continue
    name = " ".join(r.get("NAME", "").split())
    fleet[name.upper()] += 1
    mfr, mdl = models.get(r.get("MFR MDL CODE", ""), ("", ""))
    if not mfr and r.get("KIT MFR"):
        mfr, mdl = r.get("KIT MFR", ""), r.get("KIT MODEL", "")
    emfr, emdl = engines.get(r.get("ENG MFR MDL", ""), ("", ""))
    country = r.get("COUNTRY", "")
    where = r.get("STATE", "") if country in ("US", "") else country
    recs.append((hx, ["N" + r.get("N-NUMBER", ""), name, REGTYPE.get(r.get("TYPE REGISTRANT", ""), ""), title(r.get("CITY", "")), where,
                      r.get("CERT ISSUE DATE", ""), r.get("EXPIRATION DATE", ""), cert(r.get("CERTIFICATION", "")), r.get("AIR WORTH DATE", ""),
                      r.get("YEAR MFR", ""), " ".join((title(mfr) + " " + mdl).split()), " ".join((title(emfr) + " " + emdl).split()), 0]))

shards = collections.defaultdict(dict)
for hx, rec in recs:
    rec[12] = fleet[rec[1].upper()] if rec[1] else 0
    shards[hx[:3]][hx] = rec
os.makedirs(os.path.join(out, "faa"), exist_ok=True)
for k, v in shards.items():
    with open(os.path.join(out, "faa", k + ".json"), "w") as fh:
        json.dump(v, fh, separators=(",", ":"))
with open(os.path.join(out, "faa", "meta.json"), "w") as fh:
    json.dump({"built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"), "aircraft": len(recs), "source": "FAA Releasable Aircraft Database"}, fh)
print("aircraft", len(recs), "shards", len(shards))
