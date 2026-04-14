/**
 * CDF Decision Engine — SPRC / DNJ4
 *
 * Classifies each CDF negative feedback case as:
 *   DISPUTE  → Driver NOT at fault, prepare dispute submission
 *   COACH    → Driver AT fault, generate coaching session
 *   REVIEW   → Ambiguous, needs human judgment
 *
 * Rules derived from:
 *   - AMZL CDF Metric Guide (dispute reasons, feedback categories)
 *   - Scorecard Data Dispute Guide (eligible reasons, required fields)
 *   - Week 14 test data patterns
 */

// ============================================================
// FEEDBACK CATEGORY MAPPING (L2 → L3 from AMZL Guide)
// ============================================================
const FEEDBACK_CATEGORIES = {
    'DA did not follow my delivery instructions': {
        l2: 'Delivery Quality',
        coachable: true,
        disputable: true,
        dispute_reason: 'Driver did not Follow my Delivery Instructions'
    },
    'Package was not in the location indicated by the photo': {
        l2: 'Delivery Quality',
        coachable: false,
        disputable: true,
        dispute_reason: 'Delivered to Wrong Address'
    },
    'DA delivered to wrong address': {
        l2: 'Delivery Quality',
        coachable: true,
        disputable: true,
        dispute_reason: 'Delivered to Wrong Address'
    },
    'DA threw my package': {
        l2: 'Delivery Quality',
        coachable: true,
        disputable: true,
        dispute_reason: 'Negative Customer Feedback for DA based on Medical Condition/Disability'
    },
    'DA drove on my lawn/grass/plants/mulch': {
        l2: 'DA Behavior',
        coachable: true,
        disputable: false,
        dispute_reason: null
    },
    'DA was unprofessional': {
        l2: 'DA Behavior',
        coachable: true,
        disputable: false,
        dispute_reason: null
    },
    'DA mishandled my package': {
        l2: 'Delivery Quality',
        coachable: true,
        disputable: true,
        dispute_reason: null
    },
    'Unsafe delivery conditions': {
        l2: 'Delivery Quality',
        coachable: false,
        disputable: true,
        dispute_reason: 'Unsafe Delivery Conditions'
    }
};

// ============================================================
// DECISION RULES
// ============================================================

/**
 * Core classification function
 * @param {Object} caseData - Single CDF case with all investigation data
 * @returns {Object} { verdict, confidence, reasons[], dispute_data?, coaching_data? }
 */
function classifyCase(caseData) {
    const {
        feedback_category,
        feedback_detail,
        customer_notes,
        safe_delivery_location,
        dropoff_scan,
        geopin_distance,
        pod_photo_description,
        address
    } = caseData;

    const reasons = [];
    let disputeScore = 0;
    let coachScore = 0;
    let reviewFlags = [];

    const categoryConfig = FEEDBACK_CATEGORIES[feedback_category] || null;
    const hasCustomerNotes = customer_notes && customer_notes.trim().length > 0;
    const geopin = parseFloat(geopin_distance) || null;

    // -----------------------------------------------------------
    // RULE 1: Geopin distance check
    // -----------------------------------------------------------
    if (geopin !== null) {
        if (geopin <= 5) {
            disputeScore += 3;
            reasons.push(`Geopin very close (${geopin}m) — delivery location accurate`);
        } else if (geopin <= 10) {
            disputeScore += 2;
            reasons.push(`Geopin within acceptable range (${geopin}m)`);
        } else if (geopin <= 15) {
            disputeScore += 1;
            reasons.push(`Geopin borderline acceptable (${geopin}m)`);
        } else if (geopin <= 20) {
            reviewFlags.push(`Geopin elevated (${geopin}m) — may need manual check`);
        } else {
            coachScore += 2;
            reasons.push(`Geopin far from planned location (${geopin}m) — possible wrong delivery`);
        }
    } else {
        reviewFlags.push('Geopin distance not available');
    }

    // -----------------------------------------------------------
    // RULE 2: "Package not in photo location" — most common dispute
    // -----------------------------------------------------------
    if (feedback_category === 'Package was not in the location indicated by the photo') {
        // If photo shows package at door + close geopin → DISPUTE
        if (geopin !== null && geopin <= 15) {
            disputeScore += 3;
            reasons.push('Photo location complaint but geopin confirms accurate delivery');
        }
        // Check if delivered to a reasonable location
        if (dropoff_scan && (
            dropoff_scan.includes('DOORSTEP') ||
            dropoff_scan.includes('FRONT_DOOR') ||
            dropoff_scan.includes('MAIL_ROOM') ||
            dropoff_scan.includes('RECEPTION')
        )) {
            disputeScore += 2;
            reasons.push(`Delivered to standard location: ${dropoff_scan}`);
        }
        // If no customer instructions violated
        if (!hasCustomerNotes) {
            disputeScore += 1;
            reasons.push('No specific customer delivery instructions to violate');
        }
    }

    // -----------------------------------------------------------
    // RULE 3: "Did not follow delivery instructions"
    // -----------------------------------------------------------
    if (feedback_category === 'DA did not follow my delivery instructions') {
        if (hasCustomerNotes) {
            // Check if delivery matches customer instructions
            const notesLower = customer_notes.toLowerCase();
            const dropoffLower = (dropoff_scan || '').toLowerCase();
            const podLower = (pod_photo_description || '').toLowerCase();

            // Instruction compliance checks
            const instructionConflicts = [];

            // "mailroom" instruction check
            if (notesLower.includes('mailroom') || notesLower.includes('mail room')) {
                if (dropoffLower.includes('mail_room') || dropoffLower.includes('mailroom')) {
                    disputeScore += 3;
                    reasons.push('Customer said mailroom — driver delivered to mailroom');
                } else {
                    coachScore += 3;
                    instructionConflicts.push('Customer requested mailroom delivery but package not delivered there');
                }
            }

            // "front door" / "door only" instruction check
            if (notesLower.includes('door only') || notesLower.includes('front door only') || notesLower.includes('at the door')) {
                // Check for specific placement issues FIRST — these override generic door match
                let hasSpecificPlacement = notesLower.includes('table') || notesLower.includes('not on stairs') || notesLower.includes('porch') || notesLower.includes('bench') || notesLower.includes('mat');
                if (!hasSpecificPlacement) {
                    // Only give credit for generic "door" delivery if no specific placement was requested
                    if (dropoffLower.includes('doorstep') || dropoffLower.includes('front_door')) {
                        disputeScore += 2;
                        reasons.push('Customer said door only — driver delivered to door');
                    }
                }
                // Check for specific placement issues (tables, stairs, etc.)
                if (hasSpecificPlacement) {
                    // More specific instructions — needs photo/evidence check
                    if (pod_photo_description) {
                        // Check if photo CONFIRMS compliance (e.g., "on table") vs DENIES it (e.g., "not on table", "floor")
                        const photoConfirmsTable = notesLower.includes('table') &&
                            podLower.includes('table') &&
                            !podLower.includes('not on table') &&
                            !podLower.includes('no table') &&
                            !podLower.includes('floor');
                        const photoShowsNonCompliance = podLower.includes('floor') ||
                            podLower.includes('not on table') ||
                            podLower.includes('stairs') ||
                            podLower.includes('ground');

                        if (photoConfirmsTable) {
                            disputeScore += 2;
                            reasons.push('Photo confirms package on table as instructed');
                        } else if (notesLower.includes('table') && photoShowsNonCompliance) {
                            coachScore += 4;
                            instructionConflicts.push('Customer requested table placement — photo shows package on floor/not on table');
                        } else if (notesLower.includes('table') && !podLower.includes('table')) {
                            coachScore += 3;
                            instructionConflicts.push('Customer requested table placement — photo shows otherwise');
                        }
                    } else {
                        reviewFlags.push('Specific placement instructions exist but no photo description to verify');
                    }
                }
            }

            // "garage" instruction check
            if (notesLower.includes('garage')) {
                if (dropoffLower.includes('garage')) {
                    disputeScore += 3;
                    reasons.push('Customer said garage — driver delivered to garage');
                } else {
                    coachScore += 2;
                    instructionConflicts.push('Customer requested garage delivery');
                }
            }

            // "back door" / "side door" instruction check
            if (notesLower.includes('back door') || notesLower.includes('side door') || notesLower.includes('rear')) {
                if (dropoffLower.includes('back') || dropoffLower.includes('side') || dropoffLower.includes('rear')) {
                    disputeScore += 2;
                    reasons.push('Driver followed alternate door instructions');
                } else {
                    coachScore += 2;
                    instructionConflicts.push('Customer requested alternate door delivery');
                }
            }

            // Log instruction conflicts as coaching reasons
            if (instructionConflicts.length > 0) {
                reasons.push(...instructionConflicts);
            }
        } else {
            // No customer notes but complaint about not following instructions
            disputeScore += 2;
            reasons.push('Complaint about instructions but no customer notes on file');
        }
    }

    // -----------------------------------------------------------
    // RULE 4: "Delivered to wrong address"
    // -----------------------------------------------------------
    if (feedback_category === 'DA delivered to wrong address') {
        if (geopin !== null && geopin <= 10) {
            disputeScore += 3;
            reasons.push(`Geopin close (${geopin}m) — likely GPS/mapping issue, not driver error`);
        } else if (geopin !== null && geopin > 20) {
            coachScore += 3;
            reasons.push(`Geopin far (${geopin}m) — delivered to wrong location`);
        }

        // Multi-unit / apartment check
        if (feedback_detail && (
            feedback_detail.toLowerCase().includes('wrong unit') ||
            feedback_detail.toLowerCase().includes('wrong apartment') ||
            feedback_detail.toLowerCase().includes('wrong door')
        )) {
            if (hasCustomerNotes) {
                // Customer provided unit info — driver should have followed
                coachScore += 2;
                reasons.push('Wrong unit/apartment — customer notes had specific unit info');
            } else {
                reviewFlags.push('Wrong unit complaint but no customer notes specifying unit');
            }
        }
    }

    // -----------------------------------------------------------
    // RULE 5: "Driver threw package"
    // -----------------------------------------------------------
    if (feedback_category === 'DA threw my package') {
        if (pod_photo_description) {
            const podLower = pod_photo_description.toLowerCase();
            if (podLower.includes('neatly') || podLower.includes('placed') || podLower.includes('careful') || podLower.includes('on step') || podLower.includes('on porch')) {
                disputeScore += 3;
                reasons.push('Photo shows package placed neatly — contradicts throwing claim');
            } else if (podLower.includes('thrown') || podLower.includes('tossed') || podLower.includes('damaged') || podLower.includes('far from door')) {
                coachScore += 3;
                reasons.push('Photo evidence suggests mishandling');
            }
        } else {
            reviewFlags.push('Throwing complaint but no photo description to verify');
        }

        // Close geopin supports dispute
        if (geopin !== null && geopin <= 5) {
            disputeScore += 2;
            reasons.push('Very close geopin — driver was at the delivery point');
        }
    }

    // -----------------------------------------------------------
    // RULE 6: Behavior complaints (grass/mulch, unprofessional)
    // -----------------------------------------------------------
    if (feedback_category === 'DA drove on my lawn/grass/plants/mulch' ||
        feedback_category === 'DA was unprofessional') {
        // Behavior complaints are NOT disputable — always coach
        // Use high weight to override any geopin-based dispute points
        coachScore += 5;
        reasons.push(`Behavior complaint: ${feedback_category} — coaching required`);

        if (hasCustomerNotes) {
            coachScore += 2;
            reasons.push('Customer notes specifically mention the behavior issue');
        }

        // Nullify any geopin-based dispute score for behavior complaints
        // (close geopin is irrelevant — the issue is behavior, not location)
        disputeScore = 0;
        reasons.push('Geopin distance not relevant for behavior complaints');
    }

    // -----------------------------------------------------------
    // RULE 7: Dropoff location matches safe delivery preference
    // -----------------------------------------------------------
    if (safe_delivery_location && dropoff_scan) {
        const safeLower = safe_delivery_location.toLowerCase();
        const dropLower = dropoff_scan.toLowerCase();

        const matchMap = {
            'front door': ['doorstep', 'front_door'],
            'mailroom': ['mail_room', 'mailroom'],
            'reception': ['reception', 'front_desk'],
            'garage': ['garage'],
            'back door': ['back_door', 'rear']
        };

        for (const [pref, scans] of Object.entries(matchMap)) {
            if (safeLower.includes(pref)) {
                if (scans.some(s => dropLower.includes(s))) {
                    disputeScore += 1;
                    reasons.push(`Delivery matches safe location preference: ${safe_delivery_location}`);
                }
                break;
            }
        }
    }

    // -----------------------------------------------------------
    // RULE 8: Product/service complaint (not delivery related)
    // -----------------------------------------------------------
    if (feedback_detail) {
        const detailLower = feedback_detail.toLowerCase();
        const productKeywords = ['damaged', 'broken', 'wrong item', 'missing item', 'defective', 'expired', 'opened'];
        const isProductIssue = productKeywords.some(k => detailLower.includes(k)) &&
            !detailLower.includes('delivery') && !detailLower.includes('driver');

        if (isProductIssue) {
            disputeScore += 3;
            reasons.push('Feedback appears to be about product quality, not delivery');
        }
    }

    // -----------------------------------------------------------
    // FINAL CLASSIFICATION
    // -----------------------------------------------------------
    let verdict, confidence;

    if (reviewFlags.length >= 2 && Math.abs(disputeScore - coachScore) <= 2) {
        verdict = 'REVIEW';
        confidence = 'low';
    } else if (disputeScore > coachScore + 1) {
        verdict = 'DISPUTE';
        confidence = disputeScore >= 5 ? 'high' : 'medium';
    } else if (coachScore > disputeScore + 1) {
        verdict = 'COACH';
        confidence = coachScore >= 5 ? 'high' : 'medium';
    } else if (disputeScore === coachScore) {
        verdict = 'REVIEW';
        confidence = 'low';
    } else if (disputeScore > coachScore) {
        verdict = 'DISPUTE';
        confidence = 'low';
    } else {
        verdict = 'COACH';
        confidence = 'low';
    }

    // Override to REVIEW if too many flags
    if (reviewFlags.length >= 3) {
        verdict = 'REVIEW';
        confidence = 'low';
    }

    // -----------------------------------------------------------
    // BUILD RESULT
    // -----------------------------------------------------------
    const result = {
        verdict,
        confidence,
        dispute_score: disputeScore,
        coach_score: coachScore,
        reasons,
        review_flags: reviewFlags
    };

    // Add dispute data if DISPUTE
    if (verdict === 'DISPUTE' && categoryConfig && categoryConfig.disputable) {
        result.dispute_data = {
            dispute_reason: categoryConfig.dispute_reason,
            tracking_id: caseData.tracking_id,
            transporter_id: caseData.transporter_id,
            driver_name: caseData.driver_name,
            delivery_date: caseData.delivery_date,
            evidence_summary: reasons.filter(r => !r.includes('coaching')).join('; ')
        };
    }

    // Add coaching data if COACH
    if (verdict === 'COACH') {
        result.coaching_data = {
            category: feedback_category,
            driver_name: caseData.driver_name,
            tracking_id: caseData.tracking_id,
            delivery_date: caseData.delivery_date,
            address: caseData.address,
            customer_notes: customer_notes || 'None provided',
            what_happened: feedback_detail || feedback_category,
            coaching_guidance: getCoachingGuidance(feedback_category)
        };
    }

    return result;
}

// ============================================================
// COACHING GUIDANCE BY CATEGORY
// ============================================================
function getCoachingGuidance(category) {
    const guidance = {
        'DA did not follow my delivery instructions': {
            expectation: 'Always read customer notes BEFORE delivering. Follow placement instructions exactly as written.',
            tips: [
                'Check the app for delivery notes before approaching the door',
                'If notes mention a specific location (table, garage, side door), deliver there',
                'If instructions are unclear, use best judgment but prioritize following notes',
                'Take your POD photo showing the package in the requested location'
            ]
        },
        'DA delivered to wrong address': {
            expectation: 'Verify unit numbers, apartment identifiers, and address details before delivering.',
            tips: [
                'Always verify the unit/apartment number matches the app',
                'Look for identifying features mentioned in customer notes (color of door, floor, etc.)',
                'In multi-unit buildings, confirm the unit BEFORE placing the package',
                'If unsure, call/text the customer through the app'
            ]
        },
        'DA threw my package': {
            expectation: 'Always place packages gently. Never toss or drop from a distance.',
            tips: [
                'Walk the package to the delivery point — never throw',
                'Use both hands for heavy or fragile items',
                'Place packages down gently, even when in a rush',
                'Your POD photo is evidence of careful handling'
            ]
        },
        'DA drove on my lawn/grass/plants/mulch': {
            expectation: 'Use walkways, driveways, and paved paths only. Never drive or walk on lawns.',
            tips: [
                'Always park on the street or driveway',
                'Walk on sidewalks and pathways to the door',
                'Check customer notes for specific lawn/garden concerns',
                'Be extra careful in residential areas with well-maintained lawns'
            ]
        },
        'DA was unprofessional': {
            expectation: 'Maintain professional demeanor at all times. Follow Amazon standard work practices.',
            tips: [
                'Wear your uniform and badge visibly',
                'Be courteous if you interact with customers',
                'Follow all traffic and safety rules',
                'Represent SPRC professionally at every stop'
            ]
        },
        'DA mishandled my package': {
            expectation: 'Handle all packages with care regardless of size or weight.',
            tips: [
                'Use both hands for packages over 10 lbs',
                'Never stack heavy packages on fragile ones in the van',
                'Place packages down, never drop them',
                'Report damaged packages before delivery if possible'
            ]
        },
        'Package was not in the location indicated by the photo': {
            expectation: 'Ensure your POD photo clearly shows the package at the delivery location.',
            tips: [
                'Take a clear, well-lit photo showing the package AND the delivery location',
                'Include a landmark (door number, mat, house feature) in the photo',
                'Make sure the package is visible and identifiable in the photo',
                'Do not move the package after taking the photo'
            ]
        }
    };

    return guidance[category] || {
        expectation: 'Follow all standard delivery procedures and customer instructions.',
        tips: ['Review the delivery SOP', 'Ask your manager if unsure about a situation']
    };
}

// ============================================================
// SEVERITY CALCULATOR
// ============================================================
function calculateSeverity(eventsIn90Days) {
    if (eventsIn90Days <= 3) return { level: 1, label: '1st Coaching', color: '#2563EB', range: '1-3 events' };
    if (eventsIn90Days <= 7) return { level: 2, label: '2nd Coaching', color: '#D97706', range: '4-7 events' };
    if (eventsIn90Days <= 11) return { level: 3, label: 'Warning', color: '#EA580C', range: '8-11 events' };
    if (eventsIn90Days <= 14) return { level: 4, label: 'Final Warning', color: '#DC2626', range: '12-14 events' };
    return { level: 5, label: 'Termination Review', color: '#111827', range: '15+ events' };
}

// ============================================================
// COACHING SESSION GENERATOR
// ============================================================
function generateCoachingSession(driverProfile, events, weekLabel) {
    const severity = calculateSeverity(driverProfile.events_90_day);
    const sessionId = `COACH-2026-${weekLabel}-${String(driverProfile.session_count + 1).padStart(3, '0')}`;

    return {
        session_id: sessionId,
        date: new Date().toISOString().split('T')[0],
        driver: {
            name: driverProfile.name,
            transporter_id: driverProfile.transporter_id,
            hire_date: driverProfile.hire_date || 'Unknown',
            tenure_days: driverProfile.tenure_days || 0
        },
        severity: {
            level: severity.level,
            label: severity.label,
            color: severity.color,
            bg: severity.level === 1 ? 'rgba(37, 99, 235, 0.15)' :
                severity.level === 2 ? 'rgba(217, 119, 6, 0.15)' :
                severity.level === 3 ? 'rgba(234, 88, 12, 0.15)' :
                severity.level === 4 ? 'rgba(220, 38, 38, 0.15)' :
                'rgba(17, 24, 39, 0.15)'
        },
        events_this_week: events.map(e => ({
            tracking_id: e.tracking_id,
            delivery_date: e.delivery_date,
            address: e.address,
            feedback_category: e.feedback_category,
            feedback_detail: e.feedback_detail || e.feedback_category,
            customer_notes: e.customer_notes || 'None',
            safe_delivery_location: e.safe_delivery_location || 'Not specified',
            geopin_distance: e.geopin_distance
        })),
        counts: {
            events_this_week: events.length,
            events_prior_week: driverProfile.events_prior_week || 0,
            events_90_day: driverProfile.events_90_day,
            coaching_sessions: driverProfile.session_count + 1,
            remaining_before_next: getNextThreshold(driverProfile.events_90_day) - driverProfile.events_90_day,
            oldest_event_date: driverProfile.oldest_event_date || null,
            oldest_event_expires_days: driverProfile.oldest_event_expires_days || null,
            window_start: driverProfile.window_start || null,
            window_end: driverProfile.window_end || null
        },
        trend: driverProfile.trend || 'STABLE',
        fleet_size: 62
    };
}

function getNextThreshold(currentEvents) {
    if (currentEvents <= 3) return 4;
    if (currentEvents <= 7) return 8;
    if (currentEvents <= 11) return 12;
    if (currentEvents <= 14) return 15;
    return 15; // already at termination
}

// ============================================================
// DISPUTE SUBMISSION DATA BUILDER
// ============================================================
function buildDisputeSubmission(caseData, classificationResult) {
    if (!classificationResult.dispute_data) return null;

    return {
        // Required fields per Scorecard Data Dispute Guide
        tba: caseData.tracking_id,
        transporter_id: caseData.transporter_id,
        da_name: caseData.driver_name,
        delivery_date: caseData.delivery_date,
        dispute_reason: classificationResult.dispute_data.dispute_reason,

        // Evidence
        evidence_summary: classificationResult.dispute_data.evidence_summary,
        geopin_distance: caseData.geopin_distance,
        dropoff_scan: caseData.dropoff_scan,
        customer_notes: caseData.customer_notes || 'None',
        pod_photo: caseData.pod_photo_link || null,

        // Metadata
        confidence: classificationResult.confidence,
        auto_generated: true,
        status: 'Pending Review',
        created_at: new Date().toISOString()
    };
}

// ============================================================
// BATCH PROCESSOR — Run on all weekly cases
// ============================================================
function processWeeklyCases(cases) {
    const results = {
        disputes: [],
        coaching: [],
        reviews: [],
        summary: { total: 0, dispute_count: 0, coach_count: 0, review_count: 0 }
    };

    for (const c of cases) {
        const classification = classifyCase(c);
        const entry = {
            ...c,
            ...classification,
            processed_at: new Date().toISOString()
        };

        if (classification.verdict === 'DISPUTE') {
            entry.dispute_submission = buildDisputeSubmission(c, classification);
            results.disputes.push(entry);
        } else if (classification.verdict === 'COACH') {
            results.coaching.push(entry);
        } else {
            results.reviews.push(entry);
        }
    }

    results.summary = {
        total: cases.length,
        dispute_count: results.disputes.length,
        coach_count: results.coaching.length,
        review_count: results.reviews.length,
        dispute_pct: Math.round((results.disputes.length / cases.length) * 100),
        coach_pct: Math.round((results.coaching.length / cases.length) * 100),
        review_pct: Math.round((results.reviews.length / cases.length) * 100)
    };

    return results;
}

// ============================================================
// EXPORTS (for Node.js) / GLOBALS (for browser)
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        classifyCase,
        calculateSeverity,
        generateCoachingSession,
        buildDisputeSubmission,
        processWeeklyCases,
        getCoachingGuidance,
        FEEDBACK_CATEGORIES
    };
} else {
    window.CDFEngine = {
        classifyCase,
        calculateSeverity,
        generateCoachingSession,
        buildDisputeSubmission,
        processWeeklyCases,
        getCoachingGuidance,
        FEEDBACK_CATEGORIES
    };
}
