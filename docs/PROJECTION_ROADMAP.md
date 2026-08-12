# Projection roadmap — the reset

**Status of everything before this document:** the catalog authority is built. Phases 1–336 are history and
are not reopened. This is the roadmap for the projection appliance, and it is deliberately short.

## Where the product actually is

- The **control plane** works: catalog authority, operator UI, import/export, backup, restore, retention,
  custody, and a gated Jellyfin collection control plane.
- The **data plane exists, thinly, and more than one media server has now read it.** This line used to say
  "the data plane does not exist; no media server can open a file through this product", and that stopped
  being true when `deploy/projection-jellyfin-dataplane-gate.sh` started passing: a real, digest-pinned
  Jellyfin scans a ~50-entry projected corpus, direct-plays it for five minutes at the media's own rate,
  seeks ten times including backwards and past 90 % of duration, and consumes a forced transcode for five
  minutes — all through the production `projectiond` mount. Leaving the old sentence in place would have been
  the opposite of this repository's problem and just as bad: a document that disagrees with what runs.
- **"Plex and Emby are untouched" was this page's line, and it is now false twice over.** It became false for
  Plex when `deploy/projection-plex-dataplane-gate.sh` merged with a run record carrying a real count —
  **seven runs, three failing and four green**, the last three consecutive and each starting from nothing
  (`docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md` §7, which also says plainly that it is not a complete index).
  It became false for Emby when `deploy/projection-emby-dataplane-gate.sh` passed **four times, the last
  three consecutive and fresh, each 353 assertions with none failed and none skipped**
  (`docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md` §7).
- **HISTORICAL — SUPERSEDED.** The sentence this bullet used to lead with, kept whole so the record of what
  was believed when survives:
  **ALL THREE MEDIA SERVERS NOW HAVE A GATE, AND THE TRANCHE IS NO CLOSER TO CLOSING.**
  When all three media-server gates first existed, every run of every one of
  them **had been** on **Windows / Docker Desktop**, which `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6
  says closes **none** of G7–G13. What changed then was that "one of the three is untouched" **stopped being**
  the reason Phase 1 was open; the reason **was** the platform. **That is no longer true** — see the Unraid
  bullet below — and this entry is kept only so the sequence of what was believed when is not lost.
- **A FOURTH GATE RUNS ALL THREE AT ONCE. IT IS G18, AND IT HAS SINCE RUN.**
  `deploy/projection-three-server-concurrency-gate.sh` puts a real, digest-pinned Plex, Jellyfin and Emby on
  **one** production mount, **one** admitted generation, **one** ~50-entry corpus and **one** fake endpoint,
  and observes all three scanning at the same instant rather than inferring it from three triggers landing
  together. It is not a wrapper around the other three gates: running those at once would stand up three
  daemons, three mounts and three corpora and would prove something about Docker Desktop.
  `docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md` says what it asserts and what it refuses to claim.
  **HISTORICALLY** the §6.1 table recorded it as `NOT RUN`, because every run **had been** on Windows /
  Docker Desktop and `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says that closes none of G7–G13 or G18.
  **G18 HAS SINCE RUN — three consecutive fresh runs on a real Unraid host, 64 assertions each, none failed
  and none skipped**, and §6.1 records it as run. **Per-server provider attribution is impossible with one
  shared daemon and is still not claimed. HISTORICALLY this sentence continued "no real provider endpoint has
  ever been contacted, and Phase 1 remains open on that ground" — true when written, and superseded by the
  real TorBox runs recorded below. What is unchanged is the first half: G18 attributes no byte to a server.**
- **A FIFTH GATE MEASURES WHAT THE NAIVE PATH COSTS, AND IT IS A CONTROL RATHER THAN A CANDIDATE.**
  `deploy/projection-rclone-comparison-gate.sh` is G22: the **same** ~50-entry corpus behind a digest-pinned
  rclone mount of a deterministic WebDAV endpoint, read by the **same** three real, digest-pinned media
  servers, observed by G18's **own** observer and floors. `docs/ADR_002_PROJECTION_APPLIANCE.md` §2 rejected
  rclone over WebDAV as production architecture and kept it as a test control, in those words; **nothing
  measured here reopens that, a cheap number would not, and an expensive one is not what closed it.** G22 has
  **no pass threshold**, so every cost figure is recorded and compared against nothing — what fails closed is
  the instrumentation. `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` says what it measures and refuses to
  claim. **HISTORICALLY** the §6.1 table recorded **G22 as `NOT RUN`**, because every run **had been** on
  Windows / Docker Desktop; **it has since run three consecutive fresh times on a real Unraid host, 70
  assertions each.** G22 still has no pass threshold, so that is reproducibility of the instrument and not a
  verdict on the naive path.
- **DOCKER DESKTOP IS NOT UNRAID, AND EVERY GATE THAT HAS AN EXECUTABLE FORM HAS NOW RUN THERE.** Three
  consecutive fresh runs each, on a real Unraid host, none failed and none skipped: **Jellyfin** (366
  assertions per run), **Emby** (395/394/394), **Plex** (414/412/414), **G18** (64), **G22** (70),
  **G24–G26** (29) and **G27** (85) — **seven gate groups, seven 3/3 sequences.** The host preflight
  returned an authoritative verdict rather than `undetermined`, and every run left the host clean — zero
  mountpoints, where the same gate once left four behind.

- **GETTING THERE COST FIVE GATE DEFECTS AND NO PRODUCT DEFECTS, WHICH IS ITSELF THE RESULT.** A byte
  budget measured against bytes that were never written; a byte budget that was arithmetically unreachable
  on the only object it bound; a cleanup whose lazy unmount ran in a mount namespace that did not
  propagate; a scan window that was never cold because Plex had already scanned it before the window
  opened; and an encoder-liveness floor that counted throttle bursts and therefore scored LOWER on faster
  hardware. Every one was invisible on Docker Desktop.

- **AND G24-G26 HAVE NOW RUN TOO** — three consecutive fresh Unraid runs, 29 assertions each, none
  failed and none skipped: a lease lapsed under an in-flight read and was re-resolved EXACTLY once with all
  seven identity fields unchanged; twenty concurrent opens cost EXACTLY one resolution; the open inside the
  cooldown cost none and failed in 340, 345 and 377 ms against a 10,000 ms ceiling; all four malformed
  refreshed responses were refused with zero bytes accepted; and the disallowed origin was never contacted.
  No product code changed: the daemon already did all of it.

- **AND G27 HAS NOW RUN TOO** — three consecutive fresh Unraid runs, **85 assertions each**, none failed and
  none skipped. A successor moving a carried entry's path was forged into a real artifact under a real
  pointer and **refused** by the daemon with `PATH_CHANGED_FOR_CARRIED_ENTRY`, with all three servers showing
  no change; the retire → grace → delete → add sequence then ran end to end, and all three observed **exactly**
  the removal and **exactly** the addition. Whether a server preserves watch state across that pair is
  **recorded, not asserted** — none of the three did, and that fails nothing. Four defects were found and all
  four were in the gate: **no product code changed.**

- **AND THE REAL-PROVIDER CORRECTNESS GATE NOW EXISTS** — `deploy/projection-real-provider-gate.sh`,
  operator-run, file-backed and redaction-safe. It asserts real TLS, redirect refusal, `206`-only with an
  exact `Content-Range`, size agreement, digests recorded outside the mount, a backward read and one past
  90 %, finite deadlines, bounded retries, at most one refresh per read, egress allowlisting, a read-only
  mount and a positive byte count. It **supplies nothing itself**: with no operator corpus at the approved
  path it SKIPS with status 77 and says a skip closes nothing. Offline against the product's own fake
  provider it has run **3/3 consecutive fresh times on the real Unraid host, 33 assertions each**, with 60
  adversarial offline tests behind it. **THAT CLOSES NOTHING.** It proves the gate can fail; **this** gate has
  contacted no provider and its real-mode row still reads `SKIPPED (77)`. What changed is that the missing
  thing was **a run rather than a gate** — and the run happened through the sibling gate that takes TorBox's
  own inputs, `deploy/projection-torbox-real-gate.sh`, whose real-mode row is the bullet after next. **One
  gate running is not the other gate running**, and neither row is written from the other.

- **HISTORICAL — SUPERSEDED.** Kept whole, because the sentence that used to end this list was the whole of
  what was left and it is worth seeing it retired rather than deleted:
  **AND PHASE 1 STILL DOES NOT CLOSE, FOR ONE REASON AND NO LONGER FOR ANY OF THE OLD ONES.** **No real
  provider endpoint has ever been contacted.** That is the whole of what is left. For most of this document's
  life the reason was the platform; then it was the absence of a lease gate; then it was G27's missing
  lifecycle gate. **None of those is true any more.** What has been run, against which server, is
  `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.1 — and that table, not this page, is the authority on it.

- **A REAL PROVIDER ENDPOINT HAS NOW BEEN CONTACTED, AND THAT WAS THE LAST THING.**
  `npm run go:torbox-real-gate:three` completed **three consecutive fresh runs, exit 0, none skipped**, on the
  same real Unraid host, against a **real TorBox account and a real CDN**. An operator-supplied object was
  read as an **ordinary read-only file** through the production `projectiond` mount: a `stat` proving a
  regular file at exactly the published size, four operator-approved windows digest-compared against digests
  recorded **outside** the mount, a read **past 90 %** and a **backward** read, all inside a finite deadline,
  with **exactly one** access resolution per object, the mount refusing write/create/unlink/chmod, the
  loopback resolver **refused at the transport** from the gate network, neither secret and no stable
  reference anywhere the run wrote, and this run's own directory and mountpoints **asserted** gone rather
  than reported. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.15 is the authority on it, and §6.1's new
  row is the record.
- **GETTING THERE COST SIX MORE GATE DEFECTS AND, AGAIN, NO PRODUCT DEFECTS.** Nothing had ever looked at the
  inode, so a symlink or a wrong published length would have passed; the one step in the whole gate with a
  real provider behind a system call had **no deadline**, so a stalled CDN hung it rather than failing it;
  all four read-only refusals read `docker run`'s own 125/126/127 as "the mount refused it", so they could
  pass without the mount being consulted; nothing required a resolution to have **happened** or bounded how
  often one could; a failed log capture was swallowed and the reference check covered one of two logs; and
  the gate Phase 1 closes on had **no hard cleanup assertion and preserved no evidence at all**. Every one is
  pinned by a test that fails against `6c900f4` and passes after. **No threshold moved and no product code
  changed** — and the same is true of the independent review that followed, whose **fourteen** findings cost
  fourteen more corrections to gates, tests and documents and, again, nothing in the product.
- **AND AN INDEPENDENT REVIEW OF THAT RUN FOUND TWO OF ITS SIX CORRECTIONS DID NOT DO WHAT THEY CLAIMED.**
  The outer hang bound sent SIGTERM and then WAITED for the child, so in the one case it was written for — a
  read wedged in the kernel against a FUSE mount, where only a FATAL signal gets through — the gate still
  hung; and a second, unvalidated environment knob could only LOOSEN that bound, with `0` disabling it
  outright, while the documentation said there was one knob and that it could only tighten. Both are fixed,
  the bound is now **derived from the corpus** rather than defended by prose, and a test drives the shipped
  function against a SIGTERM-ignoring child instead of matching its command line.
  `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.16 records all **fourteen** findings and what each cost —
  six tabled, seven lower-severity and the Windows one — and §6.17 records the re-review that followed, which
  approved thirteen of the fourteen and blocked on the last: a Windows test figure published twice without
  ever having been measured from the shell an ordinary launch uses.
- **AND THE REMEDIATION RUN ITSELF FOUND THE MOST INTERESTING THING IN THE TRANCHE.** The first real run
  after those corrections FAILED, because **TorBox had rotated the CDN origin it hands back** and the
  operator's allowlist no longer named it — so the daemon **refused the resolved URL** and the read failed
  closed. That is the egress allowlist doing exactly what it exists for, observed against a real provider for
  the first time rather than against a fixture. It also exposed a real defect: the read program let the
  resulting EIO escape as an uncaught exception and died, so the failing run produced no evidence at all —
  the one case the evidence exists for. A failed read is now recorded with its errno, and `allowedOrigins`
  is documented as **perishable**.
- Therefore the product now does the thing it is for, **on all three media servers, on a real Unraid host,
  and against a real provider** — and **Phase 1 closes**.

## The only tranche

| | |
|---|---|
| **Projection Phase 0** | The executable product contract. `docs/ADR_002_PROJECTION_APPLIANCE.md`, `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`, `docs/schemas/projection-manifest-v1.schema.json`, `src/core/projection/*`, `test/projection-manifest-v1.ts`. **Done.** |
| **Projection Phase 1** | The **vertical slice**: manifest producer → published artifact → `projectiond` → FUSE mount → Plex, Jellyfin and Emby scanning and playing it. Local passthrough and HTTP Range adapters, in the same tranche. Gates in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md`. **Done.** The daemon, the manifest producer (`docs/PROJECTION_PHASE_1_MANIFEST_PUBLISHER.md`), the publisher-to-mount gate, **all three media-server data-plane gates**, the three-server concurrency gate, the rclone comparison control, the access-lease gate and G27's three-server path-lifecycle gate have each **run three consecutive fresh times on a real Unraid host** — seven gate groups, seven 3/3 sequences. **This row said Open for one remaining reason — that no real provider endpoint had ever been contacted — and that reason is spent:** the TorBox real-provider gate has since run **3/3 consecutive fresh times on that host against a real account and a real CDN** (§6.15). **HISTORICALLY this row read `Open`.** Whether any given gate has ever passed is §6.1 of the acceptance plan and each gate's own run record, because **a gate existing is not a gate passing** — and closing this row does not retroactively make any row in that table say more than it says. |
| **Projection Phase 2** | **Mount hardening**, plus the multi-frontend comparison harness. Three failure modes of the daemon's own mount lifecycle, each with a gate: a serve loop killed under a **living** process, the **corpse** a dead process left at the mountpoint, and a provider outage that outlasts the circuit breaker's budget. Gate definitions and run records in `docs/PROJECTION_PHASE_2_MOUNT_HARDENING.md`; the harness in `docs/PROJECTION_PHASE_2_RCLONE_BAKEOFF.md`. **Done.** All three gates ran **3/3 consecutive fresh times on the real Unraid host** — 9 of the 9 fresh runs, exit 0, zero skips — and the harness completed **all three arms** (projectiond, rclone cache-off, rclone cache-full) through provider stall, credential rotation and frontend restart, on the SAME frozen commit `235f2d3`, tree `c5a07bdc…`, image `sha256:9b701935…`, with the host's container, network, volume and mountpoint counts identical before and after every sequence. **Running them is what found everything that mattered**, including the tranche's most serious defect: `--auto-remount` unmounted the operator's bind and recovered **for the daemon and for nobody else** — the daemon logged success and no consumer could see a file. **What Done does NOT mean:** no media server was in the nine gate runs, no real provider was contacted, and the harness **declares no winner** — it has no pass threshold, closes no G-number, and its figures are measurements. G22 remains the comparison control and ADR-002 is untouched. |
| **Projection Phase 3** | **The reliability loop**: the lifecycle failures Phase 2 hardened, done with **all three real consumers attached** over a **real provider** — six arms, six cycles a run, three consecutive fresh runs, every threshold predeclared in `docs/PROJECTION_PHASE_3_RELIABILITY_LOOP.md` and committed **before** the first measured run. **CLOSED** on the real Unraid host: `go:reliability-loop-gate:three` completed **three consecutive fresh runs, exit 0, zero skips — 18 cycles, 669 verdicts, 669 pass, 0 fail, 0 skip**, arm set exactly `A1 A2 A3 A4 A5 A6` in every run, from one frozen commit whose image digest is unchanged across the whole tranche. **The assertion it existed for:** arm A3 — the mount taken out from under a living daemon — remounted in place with **all three real media servers reading the operator’s approved windows through their own binds afterwards, 3/3, in every one of the three runs**, which is the case Phase 2’s `--auto-remount` could not deliver. **Eighteen attempts and nineteen gate defects, every one in the gate and none in the product; no threshold moved.** It also produced the tranche’s one durable product-contract change: **§11 of the Phase 0 contract, consumer attachment** — a consumer must bind the projected path **before** the daemon first mounts there, demonstrated 8/0 on all three real servers with a control that must fail — and one daemon fix, the remount that asks a cold corpse nothing, pinned by a provider-free host regression and re-validated against all three Phase 2 mount-hardening gates. **What it does NOT close:** G7–G13, G18 and G22 are untouched, it is not a load test and declares no winner between frontends. |
| **Projection Phase 4** | **Mount truth**: `/readyz` stops reporting what the daemon *remembers* about its mount and starts reporting what is *observed* at it, as an additional field beside the belief. **CLOSED** on the real Unraid host: `go:mount-truth-gate:three` completed **three consecutive fresh runs, exit 0, zero skips — 18 arm verdicts, 18 pass, 0 fail, 0 skip**, six arms in every run, from one frozen commit. Provider-free by construction: the daemon is configured with no endpoint at all, so no credential, origin or operator corpus is involved anywhere in it. **The arm it exists for:** a foreign filesystem stacked ABOVE the live mount makes `mountObserved` read `foreign` while `mounted` stays true and the serve loop never notices — a divergence the supervisor genuinely cannot see — and unmounting only that overlay restores both the live observation and the pre-attached consumer’s byte digest. **STRICTLY ADDITIVE:** `ready` and `mounted` keep the exact meanings every closed gate was measured against, so no Phase 1, 2 or 3 evidence moved; folding the observation into `ready` is named as deferred rather than done. **Its own predeclared MT2 was measured FALSE and is recorded as superseded, not deleted** (§4.1): the abort formulation asked for a state a correct daemon cannot produce, because the supervisor sets `mounted` false before the observation can lag behind it. **What it does NOT close:** no G-number, no recovery claim — the daemon survives exactly what it survived before; what changed is what it can say. |

| **Projection Phase 5** | **The observation becomes operationally authoritative**: `/readyz` stops answering from what the daemon *remembers* and starts answering from what is *observed* at its mount point — through a bounded policy of a bootstrap grace, a fault hold and a recovery confirmation, not a bare comparison — while `/healthz` becomes a separate liveness surface that says in its own document that it makes no claim about the mount. **CLOSED** on the real Unraid host: `go:mount-health-gate:three` completed **three consecutive fresh runs, exit 0, zero skips — 36 arm verdicts, 36 pass, 0 fail, 0 skip**, twelve arms in every run, from frozen commit `57b4a3646332fe7b1335da18d7c15d5807090b63`, tree `5eeaca7befff4e94ac7a91a981d49c0a1341c9fb`, image `sha256:73996926dafa3078609b2ab9534032ff7032b30322fa9bcbac31643efdf82786`. **Provider-free by construction** — the daemon is configured with no endpoint at all, so no credential, origin or operator corpus is anywhere in it. **The arm it exists for:** a mount nobody can read presents as a verdict that has *stopped advancing* rather than a negative one, so `MH4` froze a second projectiond mount above the subject's and asserted `mount-observation-stale` at 6,429 / 6,408 / 6,535 ms against a 6,000 ms hold, with `mounted` still true and **zero** serve deaths — the single most dangerous failure, which without rule 5 would read as `ready`. **Five closed gates were re-run from that same frozen commit and image** — `stale-mount`, `serve-death`, `sustained-outage` and `mount-truth` three times each and `publisher-mount` once, all exit 0, zero skips. **Three clauses were predeclared, measured FALSE on the first real Tower run, and are recorded as superseded rather than deleted** (§3.3): an unconditional recovery confirmation that made the anti-flap policy contradict itself, a precedence that made `serve-loop-dead` unreportable, and an arm that passed vacuously on a live run that predated the abort it claimed to be a recovery from. **None of the three was a threshold, and §4 is byte-for-byte what was committed before the first run.** **What it does NOT close:** no G-number; `mounted` still means the remembered boolean every Phase 1–3 gate was measured against and only `ready` moved; and — the sentence Phase 6 exists to spend — **it reports, it does not act**: no restart policy changed, no new failure is handled, and the daemon survives exactly what it survived before. |
| **Projection Phase 6** | **The deployable alpha**: one canonical Unraid operator profile and command set, and the decision Phase 5 §5.1 deferred — **bounded automatic recovery**, reason-aware, budgeted, durable, and refusing anything that is not the daemon’s own mount. **CLOSED** on the real Unraid host, from **one** frozen source: commit `c70ecb05843ce22128613e78adc676b1c8ec5110`, tree `5f6a82763ecdd207dd06e308b1e55e0d6d558341`, staged byte-identically in both directions over 1,649 files, image `sha256:a5f12b92d80464a6e3e280498f22a3bd86e732718cee554b549c6ef58e53aef9` rebuilt from that same tree. `go:recovery-gate:three` completed **three consecutive fresh runs, exit 0, zero skips — 42 arm verdicts, 42 pass, 0 fail, 0 skip**; the alpha install matrix passed **11 of 11 arms** driving the shipped operator command; the seven-gate regression matrix passed with **zero failures and zero skips**. **The arm it exists for is a REFUSAL:** a foreign overlay is named `refuse-foreign-mount` / `inspect-mount-owner` and is **asserted still mounted** afterwards with nothing spent, because the likeliest foreign mount at a projection mount point is the operator’s own bind. **A FIRST CLOSURE ROW WAS WRITTEN HERE AND WITHDRAWN**: a coordinator audit found its frozen identity FALSE — it called four commits that modified `deploy/projection-alpha.sh` "gate-only", and its figures came from three different trees. Every re-run reproduced its result, so the figures were not wrong, they were **unverifiable**; §11.1.1 of the tranche document keeps the false wording and the correction added two source digests that make a stale record impossible. **Nineteen defects across thirteen attempts, EIGHT in the product**, including `NewProbeCache` sweeping the durable recovery ledger out of the one directory the operator contract requires to be durable, so the lockout that makes an infinite restart loop unreachable **did not survive a restart**. **No threshold moved.** **What it does NOT close:** no G-number; no media server was in any Phase 6 run; one host; the real-provider acceptance ran from the earlier tree and was deliberately not re-run (§11.6); and it adds no provider — `rclone` is not the architecture, ADR-002 is untouched, and Real-Debrid and Usenet have named contracts rather than support. |

| **Projection Phase 7** | **The operator-usable alpha**: Phase 6's bounded automatic recovery done to a mount that **three real, digest-pinned media servers are attached to and playing real TorBox bytes through**, which is the gap Phase 6 closed by naming — its own §12.6: *"no media server was in any Phase 6 run"*. **NO-GO, and the document says so in its own heading.** `docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md` §2–§10 is the contract, committed before the first measured run, and **no threshold in it has moved**. **NOT ONE OF THE SIX RECOVERY ARMS HAS EVER RUN**, so every sentence in §3.1 is a contract rather than a measurement, and three consecutive fresh sequences were never attempted. **WHAT DID RUN, AND IT IS THE FURTHEST THIS REPOSITORY HAS TAKEN A REAL PROVIDER:** on the real Unraid host, from one frozen tree staged byte-identically **in both directions** (independent manifests on each side hashing to the same value over 1,658 files), three real media servers bound the projected path **before anything was mounted there**, catalogued the operator's real TorBox object through their **own** predicates, read the same four approved windows **inside their own containers as their own uid**, were observed scanning it on one clock with a fully attributed three-way sample — and then **DIRECT-PLAYED IT FOR FIVE MINUTES EACH, ALL THREE SIMULTANEOUSLY**: 306 / 300 / 300 decoded media seconds against a 300 s floor, startups of 1,500 / 1,600 / 1,480 ms against 10,000 ms, with an instant measured at which all three were decoding at once. One of the three also transcoded it for a full five minutes. **Phase 3's window was thirty seconds per server and its plays were serial.** The mount-layer count at a projection mount point was measured for the first time (`1` above a floor of `0`), and the host's container, network and volume **sets** came back identical with **0** `fuse.projectiond` mounts after every attempt. **WHAT STOPPED IT IS AN OPERATOR ACTION AND NOT A PRODUCT DEFECT:** TorBox rotated to a CDN origin the operator has not allowlisted, so every read fails EIO before any arm can run — §7 predeclared that such a run is recorded as **BLOCKED rather than failed** and that this tranche does not write `endpoint.json`. **FIVE DEFECTS SO FAR AND TWO ARE IN SHIPPED PRODUCT CODE.** Three drivers wrote *"a transcode to h264 from a source that was already h264 would prove nothing"* and then compared against the codec this repository's **synthetic** fixture uses, so a correct five-minute transcode of a real **hevc** object was failed twice over. And the corpse drain Phase 6 §9.7 named as next work turned out never to be **reachable** in a container — and once it was made reachable, it removed **this daemon's own live mount**, which passed every offline test and was caught only by Phase 6's own recovery gate on a real host. **That last one is the argument for the regression matrix in a single line.** **What it does NOT close:** no G-number, no arm, no host, no provider; and it re-closes nothing in Phases 1–6. |

**HISTORICALLY — SUPERSEDED.** *There is no Phase 2 in this document. Writing one now would be a guess, and
a guess in a roadmap is how a product acquires thirty phases of scaffolding around a thing that has never
run.* That sentence was correct for exactly as long as the slice had never run end to end, and it is
retired by the condition it named rather than by an argument: the row above closed on a real Unraid host
against a real provider. The row it is replaced by is deliberately the narrowest thing that could follow —
**the daemon's own mount lifecycle**, no new frontend surface, no new evidence ceremony — and it opens
holding **nothing**, which is the only honest state for a tranche whose gates have not run.

## The anti-detour rule

**No later phase, and no new evidence, ceremony, review-gate, packaging, disposition or acceptance-record
phase, may be started before the Phase 1 vertical slice passes its hard gates on three consecutive runs on a
real Linux or Unraid host.**

**THIS RULE IS NOW SATISFIED, AND IT IS THE ONLY SENTENCE ON THIS PAGE THAT HAS EVER BEEN ABLE TO SAY SO.**
The paragraphs below are kept in their own words, because the sequence of what was believed when is the
record and a rule with teeth is worth seeing bite all the way to the end.

**HISTORICALLY — SUPERSEDED.** *This rule has not been satisfied, and the reason it has not has changed.*
**HISTORICALLY** it was unsatisfied
because three consecutive green runs on Windows and Docker Desktop are three green runs on Windows and
Docker Desktop. **That reason is spent:** the gates have since run on a real Unraid host. The rule is
unsatisfied now for the reason below, and for no other.

**HISTORICALLY — SUPERSEDED. AND THE UNRAID RUNS DO NOT SATISFY IT EITHER, WHICH IS THE WHOLE POINT OF
STATING THEM PRECISELY.** The
rule names **the Phase 1 vertical slice**, and the slice is not only the gates that have run. Every planned
Phase 1 gate now has an executable form and a 3/3 fresh Unraid sequence — **seven of them** — and **no real
provider endpoint has ever been contacted**, while the acceptance plan names a real-provider corpus and
places it on exactly this environment. **Seven gate groups passing three times each is seven gate groups
passing three times each**, and the slice is not the gates.

**What has changed is which sentence is doing the work, and it has changed three times.** For most of this
document's life the reason Phase 1 was open was the platform; that stopped being true when the gates ran on
Unraid. It was then the absence of a lease gate; that stopped being true when G24–G26 were written and ran.
It was then G27's lifecycle half; that stopped being true when G27 was written and ran. It was then the
real-provider run, alone — **and that stopped being true when `npm run go:torbox-real-gate:three` completed
three consecutive fresh runs on that same Unraid host against a real TorBox account and a real CDN, reading
an operator's own object as an ordinary read-only file through the production mount.** There is no fifth
sentence, and a partial truth recorded exactly is what this page is for.

**WHAT SATISFYING IT DOES NOT MEAN.** It means the slice runs end to end on the environment the plan names,
three times, from nothing each time. It does not retroactively widen any gate's own claim: no media server
was in the real-provider runs, one operator object is one operator object, and every quantitative property —
amplification, concurrency, re-scan cost — is still answered against the fake endpoint where the harness
controls the answers. §6.15 of the acceptance plan says what those runs refuse to claim, and that section,
not this page, is the authority.
This is a rule with teeth because this repository has the failure mode it prevents. There are 336 phases
behind it, a large fraction of which are evidence packets, review gates, closure gates, authorization
records, dispositions and acceptance seals for work whose end-to-end behaviour was never demonstrated. Each
one was individually defensible. Together they are the reason a product with a complete backup lifecycle
cannot play a file.

What the rule permits while Phase 1 is open:

- fixing a defect the slice exposes, in any layer, including the control plane;
- amending the Phase 0 contract when the slice proves a decision wrong — with the amendment written into
  `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md` and its test, not into a new document;
- anything the existing suites require to stay green.

What it does not permit, however well argued:

- a phase that produces a document about work not yet done;
- a review, gate, seal, attestation, disposition or record whose subject is the slice itself before the slice
  runs;
- a second frontend, a third source adapter, an operator UI surface, a packaging step, an Unraid template or
  a release, before the gates pass.

## How this changes the READMEs and pointers

`README.md` gains one short section stating that the product's purpose is a projection appliance, that the
existing application is its control plane, and that the data plane is Projection Phase 1. Nothing else in the
README is rewritten: everything it describes is still true and still shipped.
