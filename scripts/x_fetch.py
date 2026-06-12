#!/usr/bin/env python3
import asyncio
import json
import sys
from datetime import datetime, timezone


def parse_dt(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def build_query(req):
    keywords = []
    for keyword in req.get("keywords", []):
        keywords.append(f'"{keyword}"' if " " in keyword else keyword)
    query = " OR ".join(keywords)
    filters = []
    if req.get("language"):
        filters.append(f"lang:{req['language']}")
    if req.get("excludeRetweets", True):
        filters.append("-filter:retweets")
    return " ".join([query] + filters).strip()


def text_of(tweet):
    return getattr(tweet, "rawContent", None) or getattr(tweet, "text", None) or ""


def iso_of(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def metric(tweet, *names):
    for name in names:
        value = getattr(tweet, name, None)
        if value is not None:
            return value
    return 0


def normalize(tweet):
    user = getattr(tweet, "user", None)
    username = getattr(user, "username", "") if user else ""
    user_id = getattr(user, "id", "") if user else ""
    tweet_id = str(getattr(tweet, "id"))
    text = text_of(tweet).replace("\n", " ").strip()
    like_count = metric(tweet, "likeCount", "likes")
    repost_count = metric(tweet, "retweetCount", "retweets")
    reply_count = metric(tweet, "replyCount", "replies")
    return {
        "source": "twitter",
        "sourceType": "post",
        "sourceItemId": tweet_id,
        "canonicalUrl": f"https://x.com/{username}/status/{tweet_id}"
        if username
        else f"https://x.com/i/status/{tweet_id}",
        "title": text[:100],
        "summary": f"{text} | likes {like_count}, reposts {repost_count}, replies {reply_count}",
        "author": f"@{username}" if username else "",
        "authorId": str(user_id or ""),
        "publishedAt": iso_of(getattr(tweet, "date")),
        "raw": {
            "likeCount": like_count,
            "repostCount": repost_count,
            "replyCount": reply_count,
            "url": getattr(tweet, "url", None),
        },
    }


async def main():
    try:
        from twscrape import API
    except Exception as exc:
        print(f"twscrape is not installed: {exc}", file=sys.stderr)
        return 2

    req = json.load(sys.stdin)
    since = parse_dt(req["since"])
    until = parse_dt(req["until"])
    api = API(req["dbPath"])
    query = build_query(req)
    limit = int(req.get("limit", 100))
    items = []
    async for tweet in api.search(query, limit=limit):
        published = getattr(tweet, "date")
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        published = published.astimezone(timezone.utc)
        if since <= published < until:
            items.append(normalize(tweet))
    print(json.dumps(items, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
