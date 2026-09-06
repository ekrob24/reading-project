# Reader Leader P0.0 Contract Audit

**Author:** Manus AI  
**Audited repository:** `ekrob24/reading-project`  
**Branch:** `main`  
**Audited revision:** `1809d306e81bd238a83fc8cbc00d80597be246b0`  
**Scope:** Documentation only; no application or protected-file changes

## Executive conclusion

Reader Leader already has a usable breadth-layer path for a teacher to create a basic text, approve it, assign it to all of the teacher’s classes, let an enrolled child read it, persist a session, and play saved audio. The existing analysis also recognizes supported Irish-English variants as correct for scoring while routing them to teacher review. However, the current persisted session is a **summary record**, not the immutable ordered running record required by P0.3 and P0.4. The detailed analysis events exist only in the mutation response and are reduced to untyped intervention notes before persistence.[1] [2] [3]

The strict P0 brief therefore needs new breadth-layer persistence and procedures for material metadata and lifecycle, selective assignment, immutable session moments, append-only teacher decisions, and original-versus-reviewed metrics. It also needs role-specific response projections because the current child session contracts return teacher-review detail in their payloads, even though the current child UI does not render those fields.[1] [3] [8]

> **Overall readiness:** P0.2 is mostly present. P0.1 is partial. P0.3, P0.4, and P0.5 require additional breadth-layer contracts and persistence. Two requirements also need coordination at protected session-processing boundaries: reliably snapshotting the original generated alignment and preventing teacher-only classifications from being returned to the child by `processAndSave`.

## Current persisted model

The current MySQL schema has teacher-owned materials, class-level assignments, summary reading sessions, comments, learner language settings, and optional audio/timing metadata. It does not have material rights metadata, an approved-but-not-assigned state, persisted aligned reading moments, stable moment identifiers, or teacher decision records.[3]

| Domain | Current persistence | Important limits |
|---|---|---|
| Materials | `readingMaterials`: owner, title, reading level, source text, optional source file/key, `draft \| assigned`, timestamps | No author, rights/source, interest age, genre, or separate teacher-approved state |
| Assignments | `materialAssignments`: class ID, material ID, assigned time | Class-level only; no direct child assignment; no independent assignment API |
| Learner dialect configuration | `learnerReadingSettings.languageSupport`: `STANDARD_ENGLISH \| IRISH_ENGLISH_SUPPORT` | Configuration exists and is teacher-controlled |
| Sessions | `readingSessions`: child/material IDs, title, transcript, original accuracy, original WCPM, duration, optional audio key, mode, language support, practice words, interventions, word states, optional word timings | No expected text snapshot, ordered expected/heard alignment, event classification snapshot, confidence, stable moment IDs, or reviewed metrics |
| Review notes | `sessionComments`: session, teacher, free-text comment, timestamp | Not a structured decision or append-only classification audit |
| Audio | `readingSessions.audioStorageKey`; `wordTimings` JSON | Full-session playback exists; timing is per spoken word and may be estimated |

## Current tRPC contracts

### Materials

The material router already supports upload extraction, teacher listing, teacher review, creation, exercise generation, approval, and child retrieval.[1]

| Procedure | Authorization and input | Current output and side effects | P0 audit finding |
|---|---|---|---|
| `readerLeader.materials.extractUpload` | Teacher/admin. `{ sourceFilename: string(1..255), sourceFileBase64: string(1..7,000,000), sourceFileMime: string(1..120) }` | `{ text, sourceType: "pdf" \| "docx" \| "text", truncated, sourceFilename, storageKey }`; rejects decoded files over 5 MB | Existing but deferred by P0, which requires paste only |
| `readerLeader.materials.create` | Teacher/admin. `{ title, readingLevel, sourceText, sourceFilename?, sourceFileBase64?, sourceFileMime?, storageKey? }` | Full inserted `readingMaterials` row with `status: "draft"` by default | Partial. Missing author, rights/source, interest age, and genre |
| `readerLeader.materials.listMine` | Teacher/admin; no input | Full material rows owned by the teacher | Existing; will need richer metadata in output |
| `readerLeader.materials.review` | Teacher/admin. `{ materialId: positive integer }` | `{ material, exercise }`, where `exercise` may be null | Existing basic review contract |
| `readerLeader.materials.generateExercises` | Teacher/admin. `{ materialId }` | `{ material, exercise }`; exercise includes vocabulary, questions, activity, model, and approval timestamp | Existing, but exercise generation is not required for P0 text approval |
| `readerLeader.materials.approve` | Teacher/admin. `{ materialId }` | `{ success: true, assignedClasses: [{ id, name, joinCode }] }`; marks exercises approved, changes material to `assigned`, and assigns it to **all** classes owned by the teacher | Does not implement separate Draft → Teacher approved → Assignable states or selective assignment |
| `readerLeader.materials.assignedForMe` | Child only; no input | `Array<{ id, title, readingLevel, sourceText, exerciseSet }>` for assigned materials in the child’s enrolled classes | Existing and already used by the child reading library |

The current UI reflects the same contract: it collects only title, reading level, source text, and optional source-file fields; after save, its single **Approve & Assign** action immediately assigns the material to all current teacher classes.[10] [11]

### Assignments

There is no `assignments` router. Assignment is a side effect of `materials.approve`, and the only child-side read contract is `materials.assignedForMe`.[1] [4]

| Capability | Current state | Required breadth-layer change |
|---|---|---|
| Assign to a class | Persistence table exists | Add an explicit teacher mutation such as `assignments.assignToClasses` or `materials.assign`; validate ownership and approved status |
| Assign to an individual child | Not represented | Add a new assignment target model only if P0 truly requires child-specific assignment; otherwise define P0 as class assignment |
| List assignments for teacher | No dedicated contract | Add a query if the approval/review UI must show current targets |
| Unassign | No contract | Not required by the brief, but should be decided before schema design |
| Prevent assignment before approval | Not expressible with the current two-state material status | Add a new material lifecycle table/status and enforce it server-side |

### Sessions

The authenticated session router has two save paths, one progress query, one audio query, and teacher comments.[1]

| Procedure | Authorization and input | Current output | Persistence behavior |
|---|---|---|---|
| `readerLeader.sessions.processAndSave` | Child only after profile-access check. `{ childProfileId, materialId?, storyTitle, expectedText, audioBase64, audioMime?, durationSeconds, assessmentMode?, wordStates? }` | `{ session, analysis }` | Stores audio; transcribes; analyzes; saves summary session, interventions, word states, and word timings |
| `readerLeader.sessions.save` | Child only after profile-access check. `{ childProfileId, materialId?, storyTitle, expectedText, transcript, durationSeconds, assessmentMode?, wordStates?, demoInterventions? }` | `{ session, analysis }` | Analyzes supplied transcript and saves a summary session without audio |
| `readerLeader.sessions.childProgress` | Any linked child/parent/teacher/admin. `{ childProfileId }` | `{ profile, sessions, quizHistory, assessmentTrend, minutesReadThisWeek, learnerSettings, summary }` | Returns full `readingSessions` rows in `sessions` |
| `readerLeader.sessions.audioUrl` | Any linked child/parent/teacher/admin. `{ sessionId }` | `{ key, url, transcript, wordTimings }` | Reads the stored audio object and returns a playable URL plus transcript/timings |
| `readerLeader.sessions.comments` | Any linked role. `{ sessionId }` | Array of session comments | Read-only comments list |
| `readerLeader.sessions.addComment` | Teacher/admin. `{ sessionId, comment }` | Inserted `{ id, sessionId, teacherUserId, comment, createdAt }` row | Persists free-text feedback, not a classification decision |
| `readerLeader.dashboards.teacher` | Teacher/admin; no input | Classes, pupils, `needsReview`, materials, recent full session rows with comments, trends, presets, branding | Current teacher session/review aggregate |

The separate public `reading.processRecording` route accepts `{ audioBase64, audioMime?, expectedText, durationSeconds }` and returns a non-persisted analysis plus `transcriptionStatus`. It is explicitly a guided-demo route and should not be used as the P0 authenticated system of record.[12]

### Analysis and word states

`processAndSave` and `save` return a `ReadingAnalysis` object containing transcript, mode, original/first-pass metrics, word counts, duration, practice words, detailed events, word states, retry summary, self-corrections, model words, a child message, and a next step.[2]

| Returned structure | Current shape | Persisted? |
|---|---|---|
| Analysis event | `{ expectedWord, recognisedWord: string \| null, eventType: "correct" \| "dialect_variation" \| "substitution" \| "omission" \| "insertion" \| "repetition", action, provisionalIrishEnglish? }` | **No.** Reduced to `{ word, action, note }` interventions |
| Word state | `{ id: "word-N", text, status: "unread" \| "current" \| "correct" \| "incorrect" \| "retried_correct", attempts }` | Yes, as session JSON |
| Metrics | `accuracy`, `firstPassAccuracy`, `pace`, `firstPassWcpm`, `correctWords`, `firstPassCorrectWords`, `totalWords`, `durationSeconds` | Only `accuracy`, `wordsCorrectPerMinute`, and `durationSeconds` are stored |
| Retry data | `retrySummary`, `selfCorrections`, `modelWords` | Not stored directly; some information remains inferable from `wordStates` |

The live word-state helper compares one heard token at a time with one expected token and therefore does not itself represent a complete ordered alignment with empty expected/heard sides for insertions and omissions.[5] The analyzer’s `events` array is closer to the required alignment, but it lacks a stable moment ID, confidence value, and timestamps, and insertion events do not preserve the inserted heard token in the current event shape.[2]

### Dialect variations

Dialect behavior is enabled through `readerLeader.learners.saveSettings({ childProfileId, defaultReadingMode, targetWcpm, languageSupport })`; the corresponding query is `readerLeader.learners.settings({ childProfileId })`.[1] When `IRISH_ENGLISH_SUPPORT` is active, matched variants are scored as correct, emitted as `eventType: "dialect_variation"`, marked `provisionalIrishEnglish`, and assigned the `teacher_review` action.[2]

A deterministic existing test pair is:

> Expected: **“The thin path was caught”**  
> Heard: **“The tin pat was cot”**

With Irish-English support enabled, the analyzer returns 100% accuracy and three `dialect_variation` events, all routed to teacher review.[9]

The session persistence currently converts each dialect event into an intervention note. It does not persist `eventType: "dialect_variation"`, `recognisedWord`, or `provisionalIrishEnglish`, so a later teacher query cannot reliably distinguish an accent variant from another teacher-review event except by parsing human-readable note text.[1] [3]

### Audio

`processAndSave` stores a recording key and creates spoken-word timings. The audio query returns `{ key, url, transcript, wordTimings }`, and the existing client can play the whole recording or seek to individual spoken-word ranges when timings exist.[1] [6]

The timing builder uses transcription segments when supplied; otherwise it estimates per-word ranges evenly across the full session duration.[7] These timings identify **spoken transcript words**, not stable expected/heard running-record moments. P0.3 can therefore reuse the existing audio endpoint for full-session playback and opportunistic seeking, but linking a reviewed moment to audio requires a mapping between a stable moment and one or more spoken timing IDs.

## P0 requirement gap matrix

| P0 requirement | Existing data/contract | Gap classification | Required table/procedure or coordination |
|---|---|---|---|
| **P0.1: Paste title and text** | `materials.create` already persists title, level, and source text | Mostly exists | Extend input through a new metadata procedure or table |
| **P0.1: Author, rights/source, interest age, genre** | No fields or contract inputs | Missing persistence and API | New `readingMaterialMetadata` table, or equivalent new breadth table, plus create/update output fields |
| **P0.1: Draft → Teacher approved → Assignable** | Only `draft \| assigned`; approval and assignment are one action | Missing lifecycle | New lifecycle persistence or approval table; `materials.approveText` mutation |
| **P0.1: No assignment before approval** | Not independently enforceable | Missing rule | Assignment mutation must require current teacher approval |
| **P0.1: Teacher assigns text** | `materialAssignments` exists; `materials.approve` assigns to every teacher class | Partial | New explicit assignment mutation and, preferably, assignment-list query |
| **P0.2: Assigned story appears for child** | `materials.assignedForMe` already returns the complete reading text | Exists | No new table required |
| **P0.2: Child completes normal reading flow** | Current child page maps assigned material into the same reader and calls `processAndSave` or `save` | Exists | No new table required; server-side validation that material is assigned and expected text is canonical is still advisable |
| **P0.3: Immutable original running record** | Detailed `analysis.events` exists transiently; session summary persists | Missing immutable snapshot | New `sessionReviewRecords`/`sessionMoments` breadth table and teacher detail query |
| **P0.3: Expected/heard ordered alignment** | Analyzer returns partial event alignment; stored session has transcript and word states only | Missing persisted contract | New stable moment schema; preserve expected, heard, classification, status/confidence, retry data, and timing references |
| **P0.3: Flagged moments** | `interventions` and dashboard `needsReview` exist | Partial | Replace note-only flags with typed moment output; keep notes for display only |
| **P0.3: Session audio** | `sessions.audioUrl` and storage key exist | Exists | Reuse current procedure |
| **P0.3: Seek where timestamps exist** | `wordTimings` and client word-seek player exist | Partial but usable | Add moment-to-spoken-timing linkage in the review output; retain fallback to full audio |
| **P0.4: Append-only teacher decisions** | Free-text comments only | Missing | New `sessionMomentDecisions` table and `sessions.addMomentDecision` mutation; server supplies teacher ID and timestamp |
| **P0.4: Preserve original classification** | Original typed event is not persisted | Missing | Persist immutable moments separately; never update them |
| **P0.4: Reviewed metrics** | Only original session accuracy/WCPM are stored | Missing | New teacher review query deriving effective classification, reviewed correct-word count, reviewed accuracy, and reviewed WCPM from latest decisions |
| **P0.4: Original and reviewed metrics together** | Original summary metrics exist | Partial | Review query should return both immutable original and derived reviewed metrics; duration remains original |
| **P0.5: Deterministic dialect example** | Analyzer test pair exists and is deterministic | Logic exists; demo fixture missing | New idempotent demo fixture that persists the genuine typed moment shape and enables Irish-English support |
| **P0.5: Child sees no accent error** | Live word matching treats enabled variants as matches | UI behavior exists | Contract redaction is still required because child mutations currently receive the detailed event array |
| **P0.5: Teacher sees labelled, confirmable accent event** | Dashboard receives a generic teacher-review intervention note | Missing typed review UI/API | Teacher detail query plus decision mutation backed by typed moments |
| **P0 validation: child never receives teacher-only flagged detail** | `processAndSave` returns full `analysis.events`; `childProgress` returns full session rows including interventions | Does not meet requirement | Add role-specific projections. Redacting the `processAndSave` response requires owner coordination at the protected transcription call site or an approved replacement boundary |

## Recommended breadth-layer contracts for subsequent checkpoints

These names are recommendations, not implementation changes made by this audit.

| Proposed contract | Suggested purpose |
|---|---|
| `materials.createDraft` | Create a teacher-owned draft with title, source text, author, rights/source, interest age, genre, and reading level |
| `materials.updateDraft` | Edit metadata and text while the item remains a draft |
| `materials.approveText` | Record teacher approval without assigning |
| `assignments.assignToClasses` | Assign only approved material to selected teacher-owned classes |
| `assignments.listForMaterial` | Show current assignment targets and times |
| `sessions.teacherRecord` | Return authorized immutable moments, original metrics, reviewed metrics, audio availability, timing links, and decision history |
| `sessions.addMomentDecision` | Append `{ sessionId, momentId, newClassification, note? }`; derive teacher identity and timestamp from context |
| `sessions.childSummary` | Return only child-safe completion and progress data, excluding typed review flags and audit history |
| `sessions.parentSummary` | Return family-safe progress data without teacher-only classification details |

A robust new persistence design needs two concepts. First, an immutable session review record or `sessionMoments` table should snapshot each generated moment with a stable ID, expected token, heard token, original classification, status/confidence when available, retry information, and timing references. Second, `sessionMomentDecisions` should append decisions linked to those stable moments and record the teacher identity, new classification, optional rationale, and creation time. The existing `readingSessions.accuracy`, `wordsCorrectPerMinute`, and `durationSeconds` should remain unchanged as the original metrics.[3]

## Protected-boundary findings

Most missing P0 breadth can be built without editing the protected analyzer or dialect implementation. Two strict requirements cannot be guaranteed by the current breadth layer alone:

| Protected-boundary issue | Why it matters | Required coordination |
|---|---|---|
| Original typed analysis is not passed into persistence | `saveReadingSession` receives summary metrics, interventions, word states, and timings, but not `analysis.events` or expected text; therefore it cannot snapshot the exact generated alignment | The owner of the protected processing call site should expose or persist an immutable analysis snapshot, or explicitly approve a non-protected post-processing design with its consistency trade-offs |
| Child receives teacher-review events in `processAndSave` | The child mutation returns the entire analysis object, including `dialect_variation` and `teacher_review` events | The protected response boundary must return a child-safe projection, while the typed review record is made available only through an authorized teacher procedure |

The existing `childProgress` exposure can be corrected entirely in the breadth layer by returning a role-specific projection instead of raw `readingSessions` rows. The `processAndSave` response issue sits directly at a protected transcription call site and should be handed to its owner before P0 validation.[1] [4]

## Demo-data finding

The current local demo cohort has one teacher, one child, one parent, one assigned material, several sessions for that child, generic review notes, and a separate technical word-timing audio fixture. The administrator seed has two child profiles and two lightweight sessions. Neither seed provides the required 4–6 child profiles with 2–3 sessions each, three typed flagged moments, or a persisted typed accent-variation record.[4]

The deterministic analyzer test pair can seed the P0.5 accent case, but the fixture should be created through the same typed review-record shape used by real sessions. A frontend-only label or generic intervention note would not satisfy the brief.[9]

## Validation and repository state

`pnpm check` passed at the audited revision. No application code or protected file was modified during this audit.

| Reporting item | Result |
|---|---|
| Files changed | `docs/p0-contract-audit.md` only |
| Application code changed | None |
| Protected files changed | None |
| New environment variables | None |
| New migrations | None |
| Database changes | None |
| Validation | `pnpm check` passed |

## References

[1]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/routers/readerLeader.ts "Reader Leader tRPC router"
[2]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/reader.ts "Reading analysis contract"
[3]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/drizzle/schema.ts "Reader Leader MySQL schema"
[4]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/readerDb.ts "Reader Leader persistence and aggregate queries"
[5]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/shared/liveWordStates.ts "Live word-state contract"
[6]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/client/src/components/ReadingActions.tsx "Session audio and word-linked playback consumers"
[7]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/wordTiming.ts "Word timing generation"
[8]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/client/src/pages/Home.tsx "Child reading and session flow"
[9]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/reader.test.ts "Reading analyzer tests, including deterministic Irish-English variants"
[10]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/client/src/components/TeacherMaterialUploader.tsx "Teacher material creation UI"
[11]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/client/src/components/TeacherWorkflow.tsx "Material review and assignment workflow"
[12]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/routers.ts "Root tRPC router and guided-demo recording route"
[13]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/client/src/components/TeacherDashboard.tsx "Current teacher session review UI"
[14]: https://github.com/ekrob24/reading-project/blob/1809d306e81bd238a83fc8cbc00d80597be246b0/server/readerReports.ts "Current audience report generation"
