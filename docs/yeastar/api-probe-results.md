# Yeastar API probe — live results

- Probed at: 2026-07-31T23:36:18.743Z
- Base URL: https://hogdfpbxy.ras.yeastar.com
- `system/information` answered; see the JSON for firmware and edition.

| Group | Endpoint | Ver | Documented | HTTP | errcode | Result | Supported |
| --- | --- | --- | --- | --- | --- | --- | --- |
| System | `system/information` | v1.0 | unlisted | 200 | 0 | OK | yes |
| System | `system/information` | v2.0 | unlisted | 200 | 10001 | INTERFACE NOT EXISTED | no |
| CDR | `cdr/list` | v1.0 | true | 200 | 0 | OK | yes |
| CDR | `cdr/list` | v2.0 | true | 200 | 0 | OK | yes |
| CDR | `cdr/search` | v1.0 | true | 200 | 0 | OK | yes |
| CDR | `cdr/search` | v2.0 | true | 200 | 0 | OK | yes |
| CDR | `cdr/detail` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `myreport/list` | v1.0 | true | 200 | 0 | OK | yes |
| Call Report | `myreport/list` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Call Report | `call_report/list` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list?type=queueperformance` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list?type=queueperformance` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list?type=queueagentperformance` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list?type=queueagentperformance` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list?type=queueavgwaittalktime` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/list?type=queueavgwaittalktime` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/detail?type=queueperformance` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/detail?type=queueperformance` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/detail?type=queueagentperformance` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Call Report | `call_report/detail?type=queueagentperformance` | v2.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Queue | `queue/list` | v1.0 | true | 200 | 0 | OK | yes |
| Queue | `queue/list` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Queue | `queue/query` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Queue | `queue/query` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Queue | `queue/call_status` | v1.0 | true | 200 | 60001 | errcode 60001: DATA NOT FOUND | unclear |
| Queue | `queue/call_status` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Queue | `queue/agent_status` | v1.0 | true | 200 | 60001 | errcode 60001: DATA NOT FOUND | unclear |
| Queue | `queue/agent_status` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Queue | `queue_pause_reason/list` | v1.0 | true | 200 | 0 | OK | yes |
| Queue | `queue_pause_reason/list` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Extension | `extension/list` | v1.0 | true | 200 | 0 | OK | yes |
| Extension | `extension/list` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Extension | `extension/query` | v1.0 | true | 200 | 40002 | EXISTS (param error: PARAMETER ERROR) | yes |
| Extension | `extension/query` | v2.0 | true | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Undocumented (in use) | `queue/callstatistics` | v1.0 | false | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Undocumented (in use) | `queue/callstatistics` | v2.0 | false | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Undocumented (in use) | `queue/panel/callstatistics` | v1.0 | false | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Undocumented (in use) | `queue/panel/callstatistics` | v2.0 | false | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Undocumented (in use) | `extension/callstatistics` | v1.0 | false | 200 | 10001 | INTERFACE NOT EXISTED | no |
| Undocumented (in use) | `extension/callstatistics` | v2.0 | false | 200 | 10001 | INTERFACE NOT EXISTED | no |
