package manifest

import (
	"math"
	"sort"
	"time"
)

// Admitted is a generation the daemon is already serving, together with the digest over the exact artifact
// bytes it was admitted from. The digest is recorded rather than recomputed so a later chain check compares
// against what was actually admitted.
type Admitted struct {
	Manifest       *Manifest
	ManifestDigest string
}

// Succession is what changed between two generations, and therefore what a media server has to be told.
type Succession struct {
	Problems  []Problem
	Additions []string
	Deletions []string
	// DegradedChanges is reported for observability only. It is never a refresh trigger, in either direction.
	DegradedChanges []string
}

func (s Succession) OK() bool { return len(s.Problems) == 0 }

// RefreshRequest is what a media server is told after a swap: additions and completed explicit deletions,
// and nothing else.
//
// There is no third category, and in particular there is no silent one. A path cannot change under a carried
// entry, so there is no namespace change a media server would have to discover by reconciling and that this
// does not report. A path correction reaches a media server as a deletion and an addition, both of which are
// here. A change to or from `degraded` earns nothing: it moves no path, no inode, no size and no mtime.
type RefreshRequest struct {
	RefreshRequired bool
	Added           []string
	Removed         []string
}

func (s Succession) RefreshRequest() RefreshRequest {
	return RefreshRequest{
		RefreshRequired: len(s.Additions) > 0 || len(s.Deletions) > 0,
		Added:           s.Additions,
		Removed:         s.Deletions,
	}
}

// ValidateSuccession checks a candidate generation against the generation currently admitted. `now` is
// supplied rather than read, because a rule that consults a clock cannot be tested against a grace deadline.
func ValidateSuccession(previous Admitted, next *Manifest, now time.Time) Succession {
	p := &problemList{}
	result := Succession{}

	prev := previous.Manifest
	if next.Generation.Sequence != prev.Generation.Sequence+1 {
		p.add("SUCCESSION_SEQUENCE_NOT_NEXT", "generation.sequence")
	}
	if next.Generation.Predecessor == nil {
		p.add("SUCCESSION_PREDECESSOR_MISSING", "generation.predecessor")
	} else {
		pred := next.Generation.Predecessor
		if pred.GenerationID != prev.Generation.GenerationID {
			p.add("SUCCESSION_PREDECESSOR_ID_MISMATCH", "generation.predecessor.generationId")
		}
		if pred.Sequence != prev.Generation.Sequence {
			p.add("SUCCESSION_PREDECESSOR_SEQUENCE_MISMATCH", "generation.predecessor.sequence")
		}
		if pred.ManifestDigest != previous.ManifestDigest {
			p.add("SUCCESSION_PREDECESSOR_DIGEST_MISMATCH", "generation.predecessor.manifestDigest")
		}
	}
	if next.Generation.CreatedAt.Before(prev.Generation.CreatedAt) {
		p.add("SUCCESSION_CREATED_AT_REGRESSES", "generation.createdAt")
	}

	prevByID := make(map[string]*Entry, len(prev.Entries))
	for i := range prev.Entries {
		prevByID[prev.Entries[i].ProjectedEntryID] = &prev.Entries[i]
	}
	nextByID := make(map[string]*Entry, len(next.Entries))
	for i := range next.Entries {
		nextByID[next.Entries[i].ProjectedEntryID] = &next.Entries[i]
	}
	declaredDeletions := map[string]bool{}
	for _, id := range next.Generation.Admission.Deletions {
		declaredDeletions[id] = true
	}

	prevIDs := make([]string, 0, len(prevByID))
	for id := range prevByID {
		prevIDs = append(prevIDs, id)
	}
	sort.Strings(prevIDs)

	for _, entryID := range prevIDs {
		before := prevByID[entryID]
		after, carried := nextByID[entryID]
		short := entryID
		if len(short) > 11 {
			short = short[:11]
		}
		at := "previous:" + short

		if !carried {
			// THE RULE. An entry may leave the namespace only by being named in a deletion generation, and
			// only after it was affirmatively marked `retiring` and its grace deadline passed. Nothing about
			// a scan, a provider outage or an unreachable control plane can reach this branch.
			switch {
			case !declaredDeletions[entryID]:
				p.add("ENTRY_DISAPPEARED_WITHOUT_DELETION", at)
			case before.Visibility != "retiring" || before.Retiring == nil:
				p.add("DELETED_ENTRY_WAS_NOT_RETIRING", at)
			case before.Retiring.GraceDeadline.After(now):
				p.add("DELETED_ENTRY_GRACE_NOT_ELAPSED", at)
			default:
				result.Deletions = append(result.Deletions, entryID)
			}
			continue
		}

		// Identity is immutable across generations. This is the single property that makes a media server's
		// library survive a failover, an access-lease refresh and a daemon restart.
		if after.LogicalMediaID != before.LogicalMediaID {
			p.add("LOGICAL_MEDIA_ID_CHANGED", at)
		}
		if after.ProjectedVersionID != before.ProjectedVersionID {
			p.add("PROJECTED_VERSION_ID_CHANGED", at)
		}
		if after.Inode != before.Inode {
			p.add("INODE_CHANGED", at)
		}
		if after.SizeBytes != before.SizeBytes {
			p.add("SIZE_CHANGED", at)
		}
		if after.MtimeRaw != before.MtimeRaw {
			p.add("MTIME_CHANGED", at)
		}
		// A PATH IS IMMUTABLE FOR A CARRIED ENTRY. A media server cannot discover a new path without
		// reconciling, and a stable inode is not evidence that any particular media server preserves its own
		// library item across a rename. A corrected path is retire, delete, add — which refreshes, honestly.
		// (The control plane's contract names the servers; the data plane deliberately does not know them.)
		if after.Path != before.Path {
			p.add("PATH_CHANGED_FOR_CARRIED_ENTRY", at)
		}
		// A retiring entry does NOT expire into deletion. Its grace deadline passing changes nothing on its
		// own. An entry may also be un-retired, which is what makes a mistaken retirement recoverable.
		if before.Visibility == "retiring" && after.Visibility == "retiring" &&
			before.Retiring != nil && after.Retiring != nil &&
			after.Retiring.DeletionIntentID != before.Retiring.DeletionIntentID {
			p.add("RETIREMENT_INTENT_CHANGED", at)
		}
		if (before.Visibility == "degraded") != (after.Visibility == "degraded") {
			result.DegradedChanges = append(result.DegradedChanges, entryID)
		}
	}

	for id := range nextByID {
		if _, existed := prevByID[id]; !existed {
			result.Additions = append(result.Additions, id)
		}
	}
	deletionIDs := append([]string(nil), next.Generation.Admission.Deletions...)
	sort.Strings(deletionIDs)
	for _, declared := range deletionIDs {
		if _, existed := prevByID[declared]; !existed {
			short := declared
			if len(short) > 11 {
				short = short[:11]
			}
			p.add("DELETION_NAMES_UNKNOWN_ENTRY", "deletion:"+short)
		}
	}

	// The shrink guard, defense in depth on top of a rule that already makes this unreachable.
	budget := int(math.Max(MaxDeletionsAbsolute, math.Floor(float64(len(prev.Entries))*MaxDeletionsFraction)))
	if len(declaredDeletions) > budget && !next.Generation.Admission.DeletionGuardAcknowledged {
		p.add("SHRINK_GUARD_UNACKNOWLEDGED", "generation.admission.deletionGuardAcknowledged")
	}

	sort.Strings(result.Additions)
	sort.Strings(result.Deletions)
	sort.Strings(result.DegradedChanges)
	result.Problems = p.list
	return result
}
