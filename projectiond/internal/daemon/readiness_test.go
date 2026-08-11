package daemon

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Projection Phase 5 — the readiness policy, driven deterministically.
//
// WHY THE POLICY IS TESTED HERE AND NOT ONLY ON A HOST. Three of its four interesting states are defined by
// the PASSAGE OF TIME against a mount that is not answering: a fault that has not yet outlasted the hold, a
// recovery that has not yet been confirmed, and a bootstrap grace that has run out. A host gate can produce
// each of them once, slowly, with a real mount and a real fault; a table with a fake clock produces all of
// them, exhaustively, in microseconds — including the boundary cases either side of every threshold, which
// is where an off-by-one in a policy actually lives.
//
// THE GATE IS STILL WHAT PROVES IT IS WIRED UP. These tests drive `decideReadiness` and the status document;
// they say nothing about whether a real statfs against a real overlay produces the sample they assume. That
// is `deploy/projection-operational-mount-health-gate.sh`, and neither one is sufficient alone.

// at is a fixed instant. A policy about elapsed time must be tested against a clock the test owns, or the
// test is measuring how long it took to run.
var at = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

// baseline is a daemon that has a generation, is mounted, has no serve death, and was first mounted long
// enough ago for the bootstrap grace to be over. Every case below states only its own difference from it,
// so what each case is actually about is the line it changes.
func baseline() readinessInputs {
	return readinessInputs{
		now:            at,
		hasGeneration:  true,
		mounted:        true,
		mountedFirstAt: at.Add(-time.Hour),
		sample: &mountObservation{
			state:      MountStateLive,
			at:         at.Add(-500 * time.Millisecond),
			liveSince:  at.Add(-time.Hour),
			lastLiveAt: at.Add(-500 * time.Millisecond),
		},
	}
}

func TestReadinessPrecedenceIsTheOnePhase5Predeclared(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*readinessInputs)
		ready  bool
		reason string
	}{
		{
			// THE CONTROL, AND IT IS NOT OPTIONAL. Without a case that reaches `ok`, every case below is
			// satisfied by a policy that answers not-ready unconditionally.
			name:   "a live, fresh, confirmed mount is ready",
			mutate: func(*readinessInputs) {},
			ready:  true, reason: ReadyReasonOK,
		},
		{
			name:   "nothing admitted outranks everything",
			mutate: func(in *readinessInputs) { in.hasGeneration = false; in.mounted = false; in.serveDead = true },
			ready:  false, reason: ReadyReasonNoGeneration,
		},
		{
			name:   "not mounted outranks every observation reason",
			mutate: func(in *readinessInputs) { in.mounted = false },
			ready:  false, reason: ReadyReasonNotMounted,
		},
		{
			// A DEATH THE SUPERVISOR WATCHED IS DIRECT EVIDENCE; THE OBSERVATION IS A LATE SAMPLE OF IT.
			// Reporting the sample first would name the symptom and bury the cause.
			name: "a serve-loop death outranks the observation reasons",
			mutate: func(in *readinessInputs) {
				in.serveDead = true
				in.sample = &mountObservation{state: "foreign", at: at, lastLiveAt: at.Add(-time.Minute)}
			},
			ready: false, reason: ReadyReasonServeLoopDead,
		},
		{
			// ...AND IT OUTRANKS `not-mounted`, WHICH WAS CORRECTED AFTER MEASUREMENT. The supervisor runs
			// SetMounted(false) BEFORE RecordServeDeath and ClearServeDeath BEFORE SetMounted(true), so
			// `mounted` is false for the whole window a death is recorded in. Predeclared the other way
			// round, `serve-loop-dead` could never be reported at all — measured on the first Tower run.
			name:   "a serve-loop death outranks not-mounted, which is the only way it is ever reportable",
			mutate: func(in *readinessInputs) { in.mounted = false; in.serveDead = true },
			ready:  false, reason: ReadyReasonServeLoopDead,
		},
		{
			name: "a sustained foreign observation makes readiness false",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: "foreign", at: at,
					lastLiveAt: at.Add(-MountFaultHold - time.Millisecond)}
			},
			ready: false, reason: ReadyReasonMountNotLive,
		},
		{
			name: "a sustained corpse observation makes readiness false",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: "stale-projectiond", at: at,
					lastLiveAt: at.Add(-MountFaultHold - time.Millisecond)}
			},
			ready: false, reason: ReadyReasonMountNotLive,
		},
		{
			name: "a sustained empty mount point makes readiness false",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: "empty", at: at,
					lastLiveAt: at.Add(-MountFaultHold - time.Millisecond)}
			},
			ready: false, reason: ReadyReasonMountNotLive,
		},
		{
			// THE WEDGED-MOUNT SIGNATURE. The verdict still says live; it has simply stopped advancing,
			// because a probe that cannot answer leaves the previous sample in place to age.
			name: "a live verdict that has stopped advancing makes readiness false",
			mutate: func(in *readinessInputs) {
				old := at.Add(-MountFaultHold - time.Second)
				in.sample = &mountObservation{state: MountStateLive, at: old, liveSince: old, lastLiveAt: old}
			},
			ready: false, reason: ReadyReasonObservationStale,
		},
		{
			name: "no observation at all, past the bootstrap grace, makes readiness false",
			mutate: func(in *readinessInputs) {
				in.sample = nil
			},
			ready: false, reason: ReadyReasonObservationUnavailable,
		},
		{
			name: "a first probe that never answered, past the grace, makes readiness false",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: MountStateTimeout, at: at}
			},
			ready: false, reason: ReadyReasonObservationUnavailable,
		},
		{
			// THE ANTI-FLAP, AND IT IS THE WHOLE REASON THE POLICY IS NOT `observed == live`.
			name: "a fault younger than the hold does NOT make readiness false",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: "foreign", at: at,
					lastLiveAt: at.Add(-MountFaultHold + time.Millisecond)}
			},
			ready: true, reason: ReadyReasonOK,
		},
		{
			// THE OTHER HALF OF IT. One lucky sample restoring readiness is the same defect pointing the
			// other way, so a live run shorter than the confirmation is not yet ready.
			name: "a live run shorter than the confirmation is not yet ready",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: MountStateLive, at: at,
					liveSince: at.Add(-MountRecoveryConfirm + time.Millisecond), lastLiveAt: at}
			},
			ready: false, reason: ReadyReasonMountRecovering,
		},
		{
			name: "a live run exactly at the confirmation is ready",
			mutate: func(in *readinessInputs) {
				in.sample = &mountObservation{state: MountStateLive, at: at,
					liveSince: at.Add(-MountRecoveryConfirm), lastLiveAt: at}
			},
			ready: true, reason: ReadyReasonOK,
		},
		{
			// THE CONFIRMATION IS HYSTERESIS AND THIS IS THE CASE THAT SAYS SO. A transient the hold never
			// believed must not be re-confirmed on the way out: an unconditional confirmation would take the
			// appliance out of service for a whole second at the TAIL of every transient whose front the
			// hold had just protected — measured, on Tower, as MH6 recording `lostReady=1 (code 503)`.
			name: "a short live run after a fault the hold NEVER believed is ready at once",
			mutate: func(in *readinessInputs) {
				gap := MountFaultHold - time.Second
				in.sample = &mountObservation{state: MountStateLive, at: at,
					liveSince: at, lastLiveAt: at, runPrecededBy: at.Add(-gap)}
			},
			ready: true, reason: ReadyReasonOK,
		},
		{
			// ...AND THE OTHER SIDE OF IT, or the clause above would have removed the confirmation entirely.
			name: "a short live run after a fault the hold DID believe is not yet ready",
			mutate: func(in *readinessInputs) {
				gap := MountFaultHold + time.Second
				in.sample = &mountObservation{state: MountStateLive, at: at,
					liveSince: at, lastLiveAt: at, runPrecededBy: at.Add(-gap)}
			},
			ready: false, reason: ReadyReasonMountRecovering,
		},
		{
			// A DEATH INSIDE THE GAP IS BELIEVED HOWEVER SHORT THE GAP WAS. The supervisor remounts in about
			// a second, so a recovery from a death is exactly the case a hold-width test would wave through.
			name: "a short live run after a SHORT gap that contained a death is not yet ready",
			mutate: func(in *readinessInputs) {
				in.lastServeDeathAt = at.Add(-time.Second)
				in.sample = &mountObservation{state: MountStateLive, at: at,
					liveSince: at, lastLiveAt: at, runPrecededBy: at.Add(-2 * time.Second)}
			},
			ready: false, reason: ReadyReasonMountRecovering,
		},
		{
			// THE GRACE COVERS "WE HAVE NOT BEEN ABLE TO LOOK YET", and only that.
			name: "inside the bootstrap grace an absent observation is ready",
			mutate: func(in *readinessInputs) {
				in.mountedFirstAt = at.Add(-MountBootstrapGrace + time.Second)
				in.sample = nil
			},
			ready: true, reason: ReadyReasonOK,
		},
		{
			// ...AND IT IS BOUNDED. This is the case that says the grace cannot carry a run.
			name: "one millisecond past the bootstrap grace an absent observation is not ready",
			mutate: func(in *readinessInputs) {
				in.mountedFirstAt = at.Add(-MountBootstrapGrace)
				in.sample = nil
			},
			ready: false, reason: ReadyReasonObservationUnavailable,
		},
		{
			// THE GRACE IS NOT A GRACE FOR A BROKEN MOUNT. "We looked and it is not live" is never covered by
			// it, at any age of the process — only "we could not look" is.
			name: "inside the grace a DEFINITIVE non-live observation is still not graced",
			mutate: func(in *readinessInputs) {
				in.mountedFirstAt = at.Add(-time.Second)
				in.sample = &mountObservation{state: "foreign", at: at}
				in.lastServeDeathAt = at.Add(-500 * time.Millisecond)
			},
			ready: false, reason: ReadyReasonMountNotLive,
		},
		{
			// A DEATH FORFEITS THE GRACE FOR THE LIFE OF THE PROCESS. A daemon that has already lost its
			// namespace once does not get a fresh window in which readiness need not be observed at all —
			// that is precisely how both of this product's worst failures stayed invisible.
			name: "a recorded serve death forfeits the bootstrap grace even inside its window",
			mutate: func(in *readinessInputs) {
				in.mountedFirstAt = at.Add(-time.Second)
				in.lastServeDeathAt = at.Add(-500 * time.Millisecond)
				in.sample = nil
			},
			ready: false, reason: ReadyReasonObservationUnavailable,
		},
		{
			// ...AND IT FORFEITS THE FAULT HOLD TOO. The hold exists to stop a SAMPLING ARTEFACT being read
			// as a fault; a serve-loop exit the supervisor observed is not an artefact, it is the fault. So a
			// remount that clears the death cannot coast back to ready on a stale live observation.
			name: "a death since the last live observation is believed at once, without waiting out the hold",
			mutate: func(in *readinessInputs) {
				in.lastServeDeathAt = at.Add(-100 * time.Millisecond)
				in.sample = &mountObservation{state: "stale-projectiond", at: at,
					lastLiveAt: at.Add(-200 * time.Millisecond)}
			},
			ready: false, reason: ReadyReasonMountNotLive,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			in := baseline()
			testCase.mutate(&in)
			got := decideReadiness(in)
			if got.ready != testCase.ready || got.reason != testCase.reason {
				t.Fatalf("readiness was (%t, %q); the policy predeclared (%t, %q)",
					got.ready, got.reason, testCase.ready, testCase.reason)
			}
		})
	}
}

// THE RECOVERY MUST REQUIRE THE HEALTHY CONDITION, NOT MERELY THE ABSENCE OF THE FAULT. Phase 2's worst
// defect recovered the namespace for the daemon and for nobody else: `mounted` went true, the serve death was
// cleared, and no consumer could read a byte. A readiness that returned on those two facts alone would be
// that failure wearing this tranche's new field.
func TestRecoveryRequiresAnObservationAndNotMerelyAClearedDeath(t *testing.T) {
	death := at.Add(-2 * time.Second)
	in := baseline()
	in.lastServeDeathAt = death
	in.serveDead = false // the supervisor remounted and cleared it
	in.sample = &mountObservation{state: "stale-projectiond", at: at, lastLiveAt: at.Add(-3 * time.Second)}
	if verdict := decideReadiness(in); verdict.ready {
		t.Fatal("readiness returned on a cleared death alone, with the mount still observed not-live")
	}

	// The first live sample is not enough either: one sample is what a flapping mount produces.
	in.sample = &mountObservation{state: MountStateLive, at: at, liveSince: at, lastLiveAt: at}
	verdict := decideReadiness(in)
	if verdict.ready || verdict.reason != ReadyReasonMountRecovering {
		t.Fatalf("one live sample restored readiness: (%t, %q)", verdict.ready, verdict.reason)
	}

	// A run spanning a full confirmation is. That is at least two distinct completed live observations.
	in.sample = &mountObservation{state: MountStateLive, at: at,
		liveSince: at.Add(-MountRecoveryConfirm), lastLiveAt: at}
	if verdict := decideReadiness(in); !verdict.ready {
		t.Fatalf("a confirmed live run did not restore readiness: %q", verdict.reason)
	}
}

// A NON-LIVE SAMPLE MUST NOT RESTART THE FAULT CLOCK. If `lastLiveAt` were taken from the current sample, a
// mount that had been foreign for an hour would report a fault one interval old for ever, and the hold would
// never elapse — a policy that could not fire is worse than no policy, because it looks like one.
func TestTheFaultClockRunsFromTheLastLiveObservationNotTheLastSample(t *testing.T) {
	d := newTestDaemon(t)
	d.SetMounted(true)
	state := MountStateLive
	d.SetMountObserver(func() string { return state })
	d.SampleMount(time.Second)

	state = "foreign"
	d.SampleMount(time.Second)
	d.SampleMount(time.Second)
	d.SampleMount(time.Second)

	sample := d.mountSample.Load()
	if sample == nil || sample.state != "foreign" {
		t.Fatalf("the foreign observation did not land: %+v", sample)
	}
	if sample.lastLiveAt.IsZero() {
		t.Fatal("three non-live samples erased when the mount was last live, so the hold can never elapse")
	}
	if !sample.liveSince.IsZero() {
		t.Fatal("a non-live sample left the live run running, so a recovery would be confirmed by a fault")
	}
}

// A LIVE RUN MAY NOT SPAN A SERVE-LOOP DEATH, AND THE FIRST REAL TOWER RUN IS WHAT TAUGHT US.
//
// The supervisor remounts in about a second and the sampler probes once a second, so an abort and its whole
// recovery can pass BETWEEN two samples. The run then continues unbroken across the death and readiness comes
// straight back on an observation taken before the fault — measured on Tower as a "recovery" vouched for by a
// live run seventy-two seconds old that predated the abort entirely. An observation from before a death says
// nothing about what is on the other side of it, which is precisely Phase 2's worst defect: the remount that
// succeeded for the daemon and for nobody else.
func TestARecordedDeathBreaksTheLiveRunEvenIfNoSampleEverSawTheFault(t *testing.T) {
	d := newTestDaemon(t)
	d.SetMountObserver(func() string { return MountStateLive })
	d.SampleMount(time.Second)
	before := d.mountSample.Load().liveSince

	// The whole death and recovery happen between two samples: no non-live observation is ever taken.
	d.RecordServeDeath(nil)
	d.ClearServeDeath()

	d.SampleMount(time.Second)
	after := d.mountSample.Load()
	if !after.liveSince.After(before) {
		t.Fatal("the live run continued across a recorded serve death, so a recovery can be vouched for by " +
			"an observation taken before the fault")
	}
	// ...AND THE NEW RUN IS THEN SUBJECT TO THE CONFIRMATION, because a death is always a believed fault.
	verdict := decideReadiness(readinessInputs{
		now: time.Now(), hasGeneration: true, mounted: true, sample: after,
		mountedFirstAt:   time.Now().Add(-time.Hour),
		lastServeDeathAt: unixNanoTime(d.lastServeDeathAt.Load()),
	})
	if verdict.ready || verdict.reason != ReadyReasonMountRecovering {
		t.Fatalf("the first live sample after a death restored readiness: (%t, %q)",
			verdict.ready, verdict.reason)
	}
}

// A LIVE RUN IS A RUN. It survives repeated live samples and is broken by anything else, because the
// confirmation is meant to prove the mount stayed live rather than that it was live twice.
func TestTheLiveRunAccumulatesAndIsBrokenByANonLiveSample(t *testing.T) {
	d := newTestDaemon(t)
	state := MountStateLive
	d.SetMountObserver(func() string { return state })
	d.SampleMount(time.Second)
	first := d.mountSample.Load().liveSince
	time.Sleep(5 * time.Millisecond)
	d.SampleMount(time.Second)
	if got := d.mountSample.Load().liveSince; !got.Equal(first) {
		t.Fatal("a second live sample restarted the run, so the confirmation can never be earned")
	}

	state = "foreign"
	d.SampleMount(time.Second)
	state = MountStateLive
	d.SampleMount(time.Second)
	if got := d.mountSample.Load().liveSince; !got.After(first) {
		t.Fatal("a non-live sample did not break the live run")
	}
}

// THE STATUS DOCUMENT CARRIES THE REASON IN EVERY ANSWER, INCLUDING THE HAPPY ONE. A field that appeared only
// on failure would be one no monitor could assert on in the healthy case, and "the reason is absent" is not
// the same statement as "the reason is ok".
func TestTheStatusDocumentAlwaysCarriesAReasonCode(t *testing.T) {
	d := newTestDaemon(t)
	if got := d.Status().ReadyReason; got != ReadyReasonNoGeneration {
		t.Fatalf("a daemon with nothing admitted reported %q", got)
	}
	if got := d.Status().Ready; got {
		t.Fatal("a daemon with nothing admitted answered ready")
	}
}

// `mounted` IS UNTOUCHED BY PHASE 5, AND THAT IS THE HALF OF PHASE 4'S ADDITIVE RULE THAT SURVIVES. Readiness
// deliberately left the list; the remembered boolean did not, and every closed gate was measured against it.
func TestMountedRemainsTheRememberedBooleanPhase5DidNotTouch(t *testing.T) {
	d := newTestDaemon(t)
	d.SetMounted(true)
	d.SetMountObserver(func() string { return "foreign" })
	d.SampleMount(time.Second)
	if !d.Status().Mounted {
		t.Fatal("a foreign observation changed status.mounted, which every closed gate was measured against")
	}
}

// LIVENESS IS NOT READINESS, AND THE POINT IS THE PAIR. A supervisor keying on one endpoint cannot tell
// "restart me" from "do not send me traffic yet", and restarting a daemon whose mount is merely being
// confirmed turns a transient into an outage.
func TestLivenessAnswersAliveWhileReadinessAnswers503(t *testing.T) {
	d := newTestDaemon(t)
	// A GENERATION FIRST, because `no-generation-admitted` outranks everything and this case is about the
	// serve loop. A test that reached its 503 through the wrong reason would be asserting the wrong thing.
	admitEmptyGeneration(t, d)
	d.SetMounted(true)
	d.RecordServeDeath(errors.New("the serve loop exited"))

	server := httptest.NewServer(d.statusMux())
	defer server.Close()

	ready, readyBody := get(t, server.URL+"/readyz")
	if ready != http.StatusServiceUnavailable {
		t.Fatalf("/readyz answered %d over a dead serve loop", ready)
	}
	alive, aliveBody := get(t, server.URL+"/healthz")
	if alive != http.StatusOK {
		t.Fatalf("/healthz answered %d while the process was perfectly alive", alive)
	}

	var liveness map[string]any
	if err := json.Unmarshal(aliveBody, &liveness); err != nil {
		t.Fatal(err)
	}
	if liveness["alive"] != true {
		t.Fatalf("the liveness document does not say the process is alive: %s", aliveBody)
	}
	// IT MAKES NO CLAIM ABOUT THE MOUNT, AND IT SAYS SO. A nonclaim that has to be inferred from an absent
	// field is one a later edit adds a field beside without noticing.
	if liveness["claimsMountUsable"] != false {
		t.Fatalf("the liveness document does not disclaim the mount: %s", aliveBody)
	}
	// ...AND IT CARRIES NO MOUNT OR READINESS FIELD AT ALL. This is the assertion that stops the two surfaces
	// converging again the first time somebody finds it convenient.
	for _, forbidden := range []string{"ready", "readyReason", "mounted", "mountObserved",
		"mountObservedAgeMs", "mountLiveRunMs", "mountSinceLiveMs", "generationId", "serveError"} {
		if _, present := liveness[forbidden]; present {
			t.Fatalf("the liveness document carries %q, so it is claiming something about the mount", forbidden)
		}
	}

	// The readiness body, by contrast, must name the cause.
	var status Status
	if err := json.Unmarshal(readyBody, &status); err != nil {
		t.Fatal(err)
	}
	if status.ReadyReason != ReadyReasonServeLoopDead {
		t.Fatalf("/readyz reported %q over a dead serve loop", status.ReadyReason)
	}
}

// THE LIVENESS SURFACE IS READ-ONLY AND LOOPBACK-ONLY ON THE ROUTE, not only on the bind. The listener
// already refuses every other interface; judging the request as well means the guarantee survives this mux
// being put behind a different listener.
func TestTheLivenessSurfaceRefusesAWriteAndANonLoopbackCaller(t *testing.T) {
	d := newTestDaemon(t)
	server := httptest.NewServer(d.statusMux())
	defer server.Close()

	response, err := http.Post(server.URL+"/healthz", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("a POST to the liveness surface answered %d", response.StatusCode)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	request.RemoteAddr = "203.0.113.7:44444"
	d.statusMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("a non-loopback caller reached the liveness surface: %d", recorder.Code)
	}
}

func get(t *testing.T, url string) (int, []byte) {
	t.Helper()
	response, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body := make([]byte, 0, 4096)
	buffer := make([]byte, 1024)
	for {
		n, readErr := response.Body.Read(buffer)
		body = append(body, buffer[:n]...)
		if readErr != nil {
			break
		}
	}
	return response.StatusCode, body
}
