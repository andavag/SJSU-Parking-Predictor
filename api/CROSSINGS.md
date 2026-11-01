# West Garage crossing uploads (configuration 2)

`POST /v1/parking-crossings/batch` uses the existing installation bearer token and enrollment/revocation flow. HTTPS is required on the phone. The API listener remains loopback-only behind the existing HTTPS proxy.

Request: exactly `{ "events": [ ... ] }`, 1–25 events, at most 64 KiB JSON. Each event has exactly these fields:

```json
{
  "clientEventId": "902abe21-ea7b-4558-8005-e1695bba521b",
  "garageId": "west",
  "trackingConfigVersion": 2,
  "radiusMeters": 100,
  "direction": "entered",
  "callbackReceivedAt": "2026-10-22T17:34:00.000Z",
  "speedMetersPerSecond": 6.5,
  "speedMeasuredAt": "2026-10-22T17:34:02.000Z",
  "accuracyMeters": 8
}
```

`clientEventId` is a v4 UUID. Radii are 50, 100, 150, or 160; direction is `entered` or `exited`. Timestamps must be real UTC calendar timestamps ending in Z (optional 1–3 fractional digits). Speed and accuracy must be finite, nonnegative numbers. All three speed metadata fields must be null together when unavailable. Coordinates and every unrecognized field are rejected. Callback time is receipt time; sample time may precede or follow it. The phone validates freshness (30 seconds), accuracy (50 m), and a 10-second current-fix timeout before populating sample fields. The server does not infer event order or travel mode.

Response: `{ "acknowledgements": [{ "clientEventId": "...", "status": "accepted" }] }`. Each event gets `accepted`, `duplicate`, or `rejected` (with an `error` for rejection). Well-formed envelopes return HTTP 200 even when individual events are rejected. Missing/invalid event IDs or malformed envelopes return 400; unauthorized/revoked tokens return 401; oversized bodies return 413; write limiting returns 429; unavailable database returns 503. Maximum 10 crossing batches per client IP per minute, within the shared 30-request `/v1` limit.

Retries reuse the same event UUID and exact payload. Fixed property ordering makes JSON key order irrelevant. Duplicate success requires both the same installation and the same payload; conflicting UUID reuse is rejected. Timestamp strings are compared as supplied. Repeated Android callbacks have independent UUIDs and remain separate records.

The dedicated writer needs only SELECT and INSERT on `parking_crossing_events`. Existing installation/enrollment grants are unchanged. Tokens stay hashed in MySQL and in SecureStore on the phone. The v1 visit endpoint/table and enrollment flow are unchanged for 1.2.0 APKs.

Deployment: run `sudo bash deploy/ubuntu/deploy-west-garage.sh` from the project root. It creates the additive table/grant, installs source, restarts, then runs real loopback/MySQL health, enrollment, unauthenticated, malformed-payload, accepted, retry, conflict, and revoked-token checks. The synthetic test installation and event are removed with local MySQL administrator access; the API writer receives no DELETE permission. Failure restores the previous source/service; additive tables/grants remain. Existing data is preserved. The public HTTPS route can additionally be checked with an unauthenticated POST (expected 401).
