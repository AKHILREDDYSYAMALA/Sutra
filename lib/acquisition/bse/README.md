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

Before an announcement can be linked to a document, the watcher normalizes its
`SLONGNAME` and compares it with the manually mapped company name for that scrip
code. A mismatch is recorded as `failed`, including both names and the scrip code,
and no document is created or linked. This makes a mistyped scrip code visible
without ever attaching another company's filing.
Rows observed by the site use fields such as `NEWSID`, `SCRIP_CD`, `SLONGNAME`,
`NEWSSUB`, `CATEGORYNAME`, `DissemDT` and `ATTACHMENTNAME`; `parseAnnouncement`
is the only code that understands those payload names. Attachment names are
turned into `https://www.bseindia.com/xml-data/corpfiling/AttachLive/...` URLs.

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
