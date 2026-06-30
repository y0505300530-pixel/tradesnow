#!/usr/bin/env python3
"""
TradeSnow RSS Video Sync — with yt-dlp fallback
"""
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
import subprocess
import json
import sys
from datetime import datetime

DB_USER  = "tradesnow"
DB_PASS  = "TsV2026_LocalDb"
DB_HOST  = "127.0.0.1"
DB_NAME  = "tradesnow"

CHANNELS = {
    "cycles_trading": "UChaPkfdV0OxX3bdX_D9qaOA",
    "micha_stocks":   "UCSxjNbPriyBh9RNl_QNSAtw"
}
NS = {
    "atom":  "http://www.w3.org/2005/Atom",
    "yt":    "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/"
}

def mysql_query(sql):
    r = subprocess.run(
        ["mysql", f"-u{DB_USER}", f"-p{DB_PASS}", f"-h{DB_HOST}", DB_NAME, "-e", sql, "--skip-column-names"],
        capture_output=True, text=True
    )
    return r.stdout.strip()

def esc(s):
    return str(s).replace("\\", "\\\\").replace("'", "\\'")

def fetch_rss(channel_id):
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8")

def parse_rss(xml_str, mentor):
    root = ET.fromstring(xml_str)
    videos = []
    for entry in root.findall("atom:entry", NS):
        vid_id   = entry.find("yt:videoId", NS).text
        title    = entry.find("atom:title", NS).text or ""
        pub      = (entry.find("atom:published", NS).text or "")[:19].replace("T", " ")
        thumb_el = entry.find(".//media:thumbnail", NS)
        thumb    = thumb_el.get("url") if thumb_el is not None else ""
        videos.append({"videoId": vid_id, "title": title, "uploadDate": pub,
                        "thumbnailUrl": thumb, "mentor": mentor})
    return videos

def fetch_ytdlp(channel_id, mentor, limit=10):
    """Fallback: use yt-dlp"""
    print(f"  [yt-dlp] Fetching {mentor} ...")
    cmd = [
        "yt-dlp", "--flat-playlist", "--skip-download",
        "--print", "%(id)s\t%(title)s\t%(upload_date)s",
        f"https://www.youtube.com/channel/{channel_id}/videos",
        "--playlist-end", str(limit), "--quiet"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
    videos = []
    for line in result.stdout.strip().split("\n"):
        parts = line.split("\t", 2)
        if len(parts) < 2:
            continue
        vid_id = parts[0].strip()
        title  = parts[1].strip() if len(parts) > 1 else ""
        raw_dt = parts[2].strip() if len(parts) > 2 else ""
        if raw_dt and raw_dt != "NA" and len(raw_dt) == 8:
            pub_dt = f"{raw_dt[:4]}-{raw_dt[4:6]}-{raw_dt[6:8]} 12:00:00"
        else:
            pub_dt = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        thumb = f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg"
        videos.append({"videoId": vid_id, "title": title, "uploadDate": pub_dt,
                        "thumbnailUrl": thumb, "mentor": mentor})
    return videos

def sync():
    all_videos = []
    errors     = []
    for mentor, ch_id in CHANNELS.items():
        videos = []
        try:
            xml_str = fetch_rss(ch_id)
            videos  = parse_rss(xml_str, mentor)
            print(f"[RSS] OK {mentor}: {len(videos)} videos")
        except Exception as e:
            print(f"[RSS] FAILED {mentor}: {e} — trying yt-dlp")
            errors.append(f"{mentor}: {e}")
            try:
                videos = fetch_ytdlp(ch_id, mentor, limit=10)
                print(f"[yt-dlp] OK {mentor}: {len(videos)} videos")
            except Exception as e2:
                print(f"[yt-dlp] FAILED {mentor}: {e2}")
                errors.append(f"{mentor} yt-dlp: {e2}")
        all_videos.extend(videos)

    new_count = 0
    for v in all_videos:
        existing = mysql_query(f"SELECT id FROM channelVideos WHERE videoId='{esc(v['videoId'])}'")
        if existing:
            continue
        sql = (f"INSERT INTO channelVideos (mentor, videoId, title, uploadDate, thumbnailUrl, analyzed) VALUES ("
               f"'{esc(v['mentor'])}', '{esc(v['videoId'])}', '{esc(v['title'][:200])}', "
               f"'{esc(v['uploadDate'])}', '{esc(v['thumbnailUrl'][:300])}', 0)")
        mysql_query(sql)
        new_count += 1

    unanalyzed = mysql_query(
        "SELECT mentor, COUNT(*), GROUP_CONCAT(title SEPARATOR '||') "
        "FROM channelVideos "
        "WHERE analyzed=0 AND uploadDate >= DATE_SUB(NOW(), INTERVAL 14 DAY) "
        "GROUP BY mentor"
    )

    out = {"newVideos": new_count, "recentVideos": len(all_videos),
           "errors": errors, "unanalyzed_raw": unanalyzed}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return out

if __name__ == "__main__":
    sync()
