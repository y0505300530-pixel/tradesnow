# IBIND Watchlist Fix V2 — Updated Instructions for Claude

## Context
The PROXY_FIX_V4 patch is deployed and working for GET/POST/DELETE passthrough.
However, two IBKR-level issues remain:

1. **POST /iserver/watchlist → 503 "field 8316"**
2. **DELETE /iserver/watchlist?id=X → "Reached max retries"**

## Root Cause Analysis (from ibind source code)

### ibind RestClient internals:
```python
# ibind/base/rest_client.py
def post(self, path, params=None, ...):
    return self.request(method='POST', ..., json=params)  # sends as JSON body ✅

def delete(self, path, params=None, ...):
    return self.request('DELETE', path, ..., json=params)  # sends as JSON body ❌ (IBKR expects query string)

def request(self, method, endpoint, **kwargs):
    response = self._session.request(method=method, url=url, **kwargs)
    # kwargs includes json= or params= which goes directly to requests library
```

**Key insight:** ibind's `delete()` sends params as **JSON body** (via `json=`), NOT as query string. But IBKR's DELETE /iserver/watchlist expects `?id=X` as a **query parameter**.

---

## Fix 1: POST "field 8316" Error

The proxy is correctly forwarding the JSON body to ibind via `client.post(path, params=body)`.
ibind then sends it as `requests.post(url, json=body)` which is correct.

The "field 8316" error is from IBKR's internal FIX protocol layer. This likely means:

**Option A:** The OAuth signature is computed over a different body than what IBKR receives.
When ibind's OAuth client signs the request, it may serialize the body differently than what
`requests.post(json=...)` sends. Check if ibind's OAuth RestClient overrides `_get_headers()`
to sign the body — if it signs `json.dumps(params)` but requests sends a slightly different
serialization (e.g., different key ordering, spacing), the signature won't match, and IBKR
returns a cryptic 503 instead of a proper 401.

**Option B:** Try bypassing ibind entirely for this endpoint. Make a raw `requests.post()` call
directly to `https://api.ibkr.com/v1/api/iserver/watchlist` with proper OAuth 1.0a signing.

**Recommended approach:**
```python
# In the proxy handler, for POST /iserver/watchlist specifically:
# Instead of: client.post(path, params=body)
# Try: Use ibind's underlying session with explicit OAuth signing

import json

# Option 1: Try with explicit Content-Type and manual body
body_str = json.dumps(body)
# Use ibind's OAuth session directly:
response = client._session.request(
    method='POST',
    url=f'{client.base_url}iserver/watchlist',
    data=body_str,
    headers={'Content-Type': 'application/json'},
    verify=client.cacert,
    timeout=15
)

# Option 2: If ibind has an IbkrClient that overrides signing,
# check if there's a method like client.make_request() or client.oauth_request()
# that handles OAuth signing + body correctly
```

**Test body format (per IBKR official docs):**
```json
{
    "id": "0",
    "name": "Algo Master USA",
    "rows": [
        {"C": 265598},
        {"C": 8894}
    ]
}
```

---

## Fix 2: DELETE Retries / OAuth Signature Issue

**Problem:** The proxy appends `?id=X` to the URL path, then calls `client.delete(path)`.
But ibind's OAuth signing may compute the signature base string using just the path
WITHOUT the query string, while IBKR verifies the signature WITH the query string.
This causes a silent OAuth signature mismatch → IBKR rejects all retries.

**Recommended approach:**
```python
# For DELETE /iserver/watchlist?id=X specifically:
# Option 1: Pass id as params to ibind's delete, let it handle query string
result = client.delete('iserver/watchlist', params={'id': watchlist_id})
# BUT: ibind sends params as JSON body, not query string! So this won't work.

# Option 2: Use raw requests with OAuth signing
# Access ibind's OAuth session directly:
response = client._session.request(
    method='DELETE',
    url=f'{client.base_url}iserver/watchlist?id={watchlist_id}',
    verify=client.cacert,
    timeout=15
)

# Option 3: If ibind's OAuth client uses requests-oauthlib,
# the session should auto-sign. Just make sure the full URL
# (including query string) is passed to the session.
```

---

## Testing Commands

After applying fixes, test with:

```bash
# Test POST (create watchlist with 1 ticker)
curl -X POST http://localhost:5000/api/proxy/iserver/watchlist \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: $(openssl rand -hex 16)" \
  -H "X-Signature: <computed>" \
  -d '{"id":"0","name":"Test","rows":[{"C":265598}]}'

# Test DELETE (delete a known watchlist)
# First GET the list to find a real ID:
curl http://localhost:5000/api/proxy/iserver/watchlists?SC=USER_WATCHLIST \
  -H "X-API-Key: $API_KEY" ...

# Then DELETE with that ID:
curl -X DELETE "http://localhost:5000/api/proxy/iserver/watchlist?id=REAL_ID" \
  -H "X-API-Key: $API_KEY" ...
```

---

## Summary of Changes Needed

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| POST 503 "field 8316" | OAuth signature mismatch OR ibind body serialization | Bypass ibind's post(), use raw OAuth-signed request |
| DELETE max retries | OAuth signature excludes query string | Bypass ibind's delete(), use raw OAuth-signed request with full URL |

Both fixes require accessing ibind's underlying OAuth session directly rather than going through the `client.post()` / `client.delete()` convenience methods, because those methods don't handle query strings and body signing correctly for IBKR's watchlist endpoints.
