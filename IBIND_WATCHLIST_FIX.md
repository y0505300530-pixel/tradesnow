# IBIND Server Fix: Watchlist POST/DELETE Proxy Support

## Problem

The IBIND server's `/api/proxy/iserver/*` passthrough currently fails for **POST** and **DELETE** requests that require a JSON body or query parameters to be forwarded to the IBKR Client Portal API.

**Error on POST:**
```
RestClient.post() got an unexpected keyword argument 'json'
```

**Error on DELETE:**
```
IbkrClient: response error ... 400 :: Bad Request :: {"error":"Bad Request: id missing","statusCode":400}
```

## Root Cause

The proxy handler in the IBIND Python server uses `RestClient` (likely `ib_async` or a custom wrapper) that:
1. **POST**: Passes the request body as `json=` keyword argument, but the `RestClient.post()` method doesn't accept `json` — it likely expects `data=` or positional arguments.
2. **DELETE**: Doesn't forward query parameters (`?id=101`) to the upstream IBKR API URL.

## Required Fix

### 1. POST Fix — Forward JSON body correctly

In the proxy route handler (likely in `routes/proxy.py` or similar), find where POST requests are forwarded:

```python
# BROKEN (current):
response = client.post(upstream_url, json=request_body)

# FIX — Option A (if RestClient accepts data + headers):
response = client.post(upstream_url, data=json.dumps(request_body), 
                       headers={"Content-Type": "application/json"})

# FIX — Option B (if using requests library directly):
import requests
response = requests.post(full_ibkr_url, json=request_body, headers=auth_headers)
```

### 2. DELETE Fix — Forward query parameters

The DELETE handler strips query parameters before forwarding. Fix:

```python
# BROKEN (current):
response = client.delete(upstream_url)  # loses ?id=101

# FIX:
# Preserve the full query string from the incoming request
full_url = f"{upstream_url}?{request.query_string.decode()}" if request.query_string else upstream_url
response = client.delete(full_url)
```

## Endpoints That Need to Work

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET | `/api/proxy/iserver/watchlists?SC=USER_WATCHLIST` | None | List all watchlists (WORKS) |
| POST | `/api/proxy/iserver/watchlist` | `{"id":"0","name":"...","rows":[{"C":conid},...]}` | Create watchlist |
| DELETE | `/api/proxy/iserver/watchlist?id=<watchlist_id>` | None | Delete watchlist |

## Testing

After the fix, these should work:

```bash
# 1. List watchlists (already works)
GET /api/proxy/iserver/watchlists?SC=USER_WATCHLIST → 200

# 2. Create a test watchlist
POST /api/proxy/iserver/watchlist
Body: {"id":"0","name":"Test","rows":[{"C":265598}]}
→ Should return 200 with the new watchlist ID

# 3. Delete the test watchlist
DELETE /api/proxy/iserver/watchlist?id=<new_id>
→ Should return 200
```

## Context

The tradesnow.vip app's "Favorites" page has a "Sync to IBKR" button that:
1. Gets all catalog tickers + their IBKR conids
2. Splits into USA and TASE lists
3. Deletes existing "Algo Master USA" / "Algo Master ISR" watchlists
4. Creates new ones with the current conid set

This enables the user to see the full catalog on the IBKR mobile app's Watchlists tab.
