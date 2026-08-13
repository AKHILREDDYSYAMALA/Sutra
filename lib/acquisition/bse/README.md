# BSE corporate-announcements client

This is a deliberately thin client for BSE's **unofficial** endpoint. It is
enabled as a deliberate, low-volume interim source for a curated pre-revenue
watchlist of SEBI-mandated public disclosures. It establishes the same public
session flow as the BSE page before calling the public JSON endpoint; it never
treats an announcement as a claim.

## Observed contract (29 July 2026)

The BSE [Corporate Announcements page](https://www.bseindia.com/corporates/ann.html)
shows date, segment, category and security filters, attachment-PDF links and a
page counter. Its website client uses this JSON endpoint:

`GET https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w`

Required query parameters for equity announcements:

| Parameter | Value |
| --- | --- |
| `pageno` | 1-based page number |
| `strCat` | `-1` for all categories |
| `subcategory` | `-1` for all subcategories |
| `strPrevDate`, `strToDate` | inclusive `YYYYMMDD` range |
| `strSearch` | `P` |
| `strscrip` | BSE scrip code |
| `strType` | `C` for equity corporate announcements |

The page first creates the ordinary BSE web session and retains its cookies for
the XHR. The JSON request has browser-equivalent `User-Agent`, `Accept`,
`Accept-Language`, `Origin`, `Referer`, and `Sec-Fetch-*` headers. This is a
specific interim decision documented in `../FINDINGS.md`, not a precedent for
the sources that expressly prohibit automation.

Responses have `Table` (announcement rows) and `Table1[0].ROWCNT` (total rows).

Before an announcement can be linked to a document, the watcher removes BSE's
trailing one-symbol listing marker (such as `Ltd-$` or `Ltd-*`) only when it
follows a legal suffix, then normalizes its `SLONGNAME` and compares it with the
manually mapped company name for that scrip code. A genuine mismatch is recorded
as `failed`, including both names and the scrip code, and no document is created
or linked. Mismatches are logged once per company with a count; the individual
rows remain in `discovered_announcements`. This makes a mistyped scrip code visible
without ever attaching another company's filing.
Rows observed by the site use fields such as `NEWSID`, `SCRIP_CD`, `SLONGNAME`,
`NEWSSUB`, `CATEGORYNAME`, `DissemDT` and `ATTACHMENTNAME`; `parseAnnouncement`
is the only code that understands those payload names. Attachment names are
turned into `https://www.bseindia.com/xml-data/corpfiling/AttachLive/...` URLs.

### Attachment archive behavior (13 August 2026)

For the saved Bharat Forge filing `537c3136-0a04-44ed-9d4e-267815b8f178.pdf`,
a session-authenticated `AttachLive` request returned 404 while the identical
filename under `AttachHis` returned `200 application/pdf`. The sampled failed
API payloads provided only `ATTACHMENTNAME`, `FILESTATUS: "N"`, and size—no
attachment path or live/historical flag. When BSE does provide an absolute or
relative attachment path, Sutra preserves it. Otherwise the filename begins at
`AttachLive`; only after its 404 does the client try `AttachHis` once. Both
requests count toward the same pace and request budget. A 404 on both paths is
terminal: the document is marked `failed` with both attempted URLs, rather than
being retried indefinitely.

Paginate only while a full page is returned. The watcher requests one mapped
scrip at a time, waits at least three seconds between **all** BSE requests
(including session setup), limits a run to 100 requests, retries a non-200 or
network failure with exponential backoff no more than three times, and refuses
source poll cycles closer than 30 minutes. Three consecutive request failures
hard-stop the current run; three failed cycles open the source circuit breaker.

A 403 or 429 stops immediately: there is no retry, proxy rotation, IP cycling,
or CAPTCHA handling. `watcher_state.disabled_until` is set at least 24 hours
ahead and `npm run watch:status` reports it. `npm run watch:bse -- --single
--scrip <code>` performs one session bootstrap and one API-page request without
touching the ledger, for bounded debugging.

BSE PDF downloads use the same process-local BSE client as announcement
requests: they reuse its cookie session (or bootstrap one), browser-equivalent
headers and BSE `Referer`, three-second pacing, retry backoff and 100-request
budget. A 403/429 leaves the document in `discovered`, defers its next retry to
the 24-hour source cooldown, and records the source error in `watcher_state`.

`--force` bypasses **only** the 30-minute poll-interval gate. It cannot bypass
the inter-request delay, the 100-request cap, retries, circuit breaker, or a
403/429 disable. `--since YYYY-MM-DD` is a manual backfill and implies that same
interval bypass; it queries from that date, reports per-company counts, and does
not advance the normal `last_announcement_date` watermark or `last_polled_at`
cadence. `--single` likewise bypasses the poll interval only, while still
honouring an active block and recording a 403/429 disable in `watcher_state`.
`--show-ignored` prints the already-audited BSE rows the relevance filter marked
`ignored` (restricted to `--since` when supplied), including company, date,
category, headline and attachment URL. It is a diagnostic only; it does not
alter relevance decisions.
