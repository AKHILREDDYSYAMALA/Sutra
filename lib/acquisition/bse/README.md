# BSE corporate-announcements client

This is a deliberately thin client for BSE's **unofficial** endpoint. It is
currently **disabled**: BSE consistently returned HTTP 406 to a plainly
identified non-browser request. Sutra will not add browser-like headers,
cookies, or another access-control workaround. The code remains for its typed
parser, fixtures, and as a source-adapter reference; it never treats an
announcement as a claim.

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

The client identifies itself as Sutra and sends only an honest API `Accept`
header. It does not impersonate a browser or circumvent access controls. During
the inspection the page returned announcements normally, but the JSON host
returned HTTP 406 to the non-browser request. `watch:bse` therefore returns
`skipped: "disabled"` without making BSE requests.

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
scrip at a time, waits at least three seconds between API requests, retries an
HTTP/network failure with exponential backoff three times, and refuses source
poll cycles closer than 15 minutes. Three consecutive failed cycles open the
source circuit breaker; inspect `npm run watch:status` before resetting that
state deliberately in the database.
