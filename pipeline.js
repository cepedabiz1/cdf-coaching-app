/**
 * CDF Pipeline — SPRC / DNJ4
 *
 * Main orchestrator that connects:
 *   1. CDF data (scraped from Amazon Logistics or manual input)
 *   2. Decision Engine (classify each case)
 *   3. Coaching Session Generator (build card data for COACH cases)
 *   4. Coaching App URL Generator (create personalized links)
 *   5. Slack Notifications (post to channels)
 *   6. Google Sheet Output (structured rows for database)
 *
 * Usage:
 *   const results = runPipeline(week14Cases, 'W14');
 */

const { classifyCase, processWeeklyCases, generateCoachingSession, calculateSeverity, buildDisputeSubmission, getCoachingGuidance } = require('./decision-engine.js');
const { formatCoachingMessage, formatDisputeMessage, formatWeeklySummary, formatReviewAlert } = require('./slack-notifier.js');

// ============================================================
// DRIVER PROFILE STORE (simulated — will use Google Sheets in prod)
// ============================================================
const DRIVER_PROFILES = {};

function getOrCreateProfile(driverName, transporterId) {
    const key = transporterId || driverName;
    if (!DRIVER_PROFILES[key]) {
        DRIVER_PROFILES[key] = {
            name: driverName,
            transporter_id: transporterId,
            hire_date: null,
            tenure_days: 0,
            events_90_day: 0,
            events_prior_week: 0,
            session_count: 0,
            oldest_event_date: null,
            oldest_event_expires_days: null,
            window_start: null,
            window_end: null,
            trend: 'STABLE'
        };
    }
    return DRIVER_PROFILES[key];
}

function updateProfileFromEvent(profile, eventCount) {
    profile.events_90_day += eventCount;
    profile.session_count += 1;

    // Calculate trend
    if (profile.events_prior_week > 0 && eventCount > profile.events_prior_week) {
        profile.trend = 'DECLINING';
    } else if (profile.events_prior_week > 0 && eventCount < profile.events_prior_week) {
        profile.trend = 'IMPROVING';
    } else {
        profile.trend = 'STABLE';
    }

    // Set 90-day window
    const now = new Date();
    profile.window_end = now.toISOString().split('T')[0];
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    profile.window_start = start.toISOString().split('T')[0];
}

// ============================================================
// COACHING URL GENERATOR
// ============================================================
function generateCoachingUrl(baseUrl, sessionData) {
    // Encode session data as base64 URL param for the static HTML app
    const encoded = Buffer.from(JSON.stringify(sessionData)).toString('base64');
    return `${baseUrl}?data=${encoded}`;
}

// ============================================================
// GOOGLE SHEET ROW BUILDER
// ============================================================
function buildSheetRow(caseData, classification, weekLabel) {
    return {
        week: weekLabel,
        date: caseData.delivery_date,
        driver_name: caseData.driver_name,
        transporter_id: caseData.transporter_id,
        tracking_id: caseData.tracking_id,
        feedback_category: caseData.feedback_category,
        feedback_detail: caseData.feedback_detail || '',
        address: caseData.address || '',
        customer_notes: caseData.customer_notes || '',
        safe_delivery_location: caseData.safe_delivery_location || '',
        dropoff_scan: caseData.dropoff_scan || '',
        geopin_distance: caseData.geopin_distance || '',
        pod_photo_link: caseData.pod_photo_link || '',
        verdict: classification.verdict,
        confidence: classification.confidence,
        dispute_score: classification.dispute_score,
        coach_score: classification.coach_score,
        dispute_reason: classification.dispute_data ? classification.dispute_data.dispute_reason : '',
        coaching_category: classification.coaching_data ? classification.coaching_data.category : '',
        status: classification.verdict === 'DISPUTE' ? 'Pending Review' :
                classification.verdict === 'COACH' ? 'Coaching Sent' : 'Needs Review',
        reasons: classification.reasons.join('; '),
        review_flags: classification.review_flags.join('; '),
        processed_at: new Date().toISOString()
    };
}

// ============================================================
// MAIN PIPELINE
// ============================================================
function runPipeline(cases, weekLabel, options = {}) {
    const {
        baseCoachingUrl = 'https://your-dsp.github.io/coaching-app/index.html',
        dryRun = false,
        verbose = true
    } = options;

    const output = {
        week: weekLabel,
        processed_at: new Date().toISOString(),
        cases_total: cases.length,

        // Classification results
        classifications: [],
        disputes: [],
        coaching: [],
        reviews: [],

        // Generated coaching sessions
        coaching_sessions: [],

        // Slack messages (ready to send)
        slack_messages: [],

        // Google Sheet rows
        sheet_rows: [],

        // Summary
        summary: {}
    };

    if (verbose) console.log(`\n🚀 CDF Pipeline — ${weekLabel} | ${cases.length} cases\n${'═'.repeat(50)}`);

    // ──────────────────────────────────────────────
    // STEP 1: Classify each case
    // ──────────────────────────────────────────────
    if (verbose) console.log('\n📋 Step 1: Classifying cases...');

    for (const c of cases) {
        const result = classifyCase(c);
        const entry = { ...c, ...result };

        output.classifications.push(entry);

        if (result.verdict === 'DISPUTE') {
            entry.dispute_submission = buildDisputeSubmission(c, result);
            output.disputes.push(entry);
        } else if (result.verdict === 'COACH') {
            output.coaching.push(entry);
        } else {
            output.reviews.push(entry);
        }

        // Build sheet row
        output.sheet_rows.push(buildSheetRow(c, result, weekLabel));

        if (verbose) {
            const emoji = result.verdict === 'DISPUTE' ? '✅' : result.verdict === 'COACH' ? '📝' : '🔍';
            console.log(`  ${emoji} ${c.driver_name.padEnd(25)} → ${result.verdict.padEnd(8)} (D:${result.dispute_score} C:${result.coach_score}) [${result.confidence}]`);
        }
    }

    // ──────────────────────────────────────────────
    // STEP 2: Group coaching cases by driver
    // ──────────────────────────────────────────────
    if (verbose) console.log('\n👤 Step 2: Generating coaching sessions...');

    const coachByDriver = {};
    for (const c of output.coaching) {
        const key = c.transporter_id || c.driver_name;
        if (!coachByDriver[key]) coachByDriver[key] = [];
        coachByDriver[key].push(c);
    }

    for (const [driverId, events] of Object.entries(coachByDriver)) {
        const firstEvent = events[0];
        const profile = getOrCreateProfile(firstEvent.driver_name, firstEvent.transporter_id);

        // Update profile with this week's events
        updateProfileFromEvent(profile, events.length);

        // Generate coaching session data (for the web app)
        const session = generateCoachingSession(profile, events, weekLabel);
        output.coaching_sessions.push(session);

        if (verbose) {
            console.log(`  🎴 ${firstEvent.driver_name} — ${session.severity.label} | ${events.length} event(s) | 90-day: ${profile.events_90_day}`);
        }
    }

    // ──────────────────────────────────────────────
    // STEP 3: Generate Slack messages
    // ──────────────────────────────────────────────
    if (verbose) console.log('\n💬 Step 3: Preparing Slack messages...');

    // Weekly summary
    const weeklyResults = { disputes: output.disputes, coaching: output.coaching, reviews: output.reviews, summary: {} };
    weeklyResults.summary = {
        total: cases.length,
        dispute_count: output.disputes.length,
        coach_count: output.coaching.length,
        review_count: output.reviews.length,
        dispute_pct: Math.round((output.disputes.length / cases.length) * 100),
        coach_pct: Math.round((output.coaching.length / cases.length) * 100),
        review_pct: Math.round((output.reviews.length / cases.length) * 100)
    };

    const summaryMsg = formatWeeklySummary(weeklyResults, weekLabel);
    output.slack_messages.push({ type: 'summary', ...summaryMsg });
    if (verbose) console.log(`  📊 Weekly summary → ${summaryMsg.channel}`);

    // Individual coaching messages
    for (const session of output.coaching_sessions) {
        const url = generateCoachingUrl(baseCoachingUrl, session);
        const msg = formatCoachingMessage(session, url);
        output.slack_messages.push({ type: 'coaching', ...msg });
        if (verbose) console.log(`  🔵 Coaching: ${session.driver.name} → ${msg.channel}`);
    }

    // Dispute messages
    for (const dispute of output.disputes) {
        const msg = formatDisputeMessage(dispute);
        if (msg) {
            output.slack_messages.push({ type: 'dispute', ...msg });
            if (verbose) console.log(`  ✅ Dispute: ${dispute.driver_name} → ${msg.channel}`);
        }
    }

    // Review alerts
    for (const review of output.reviews) {
        const msg = formatReviewAlert(review);
        output.slack_messages.push({ type: 'review', ...msg });
        if (verbose) console.log(`  🔍 Review: ${review.driver_name} → ${msg.channel}`);
    }

    // ──────────────────────────────────────────────
    // SUMMARY
    // ──────────────────────────────────────────────
    output.summary = weeklyResults.summary;

    if (verbose) {
        console.log(`\n${'═'.repeat(50)}`);
        console.log(`📊 PIPELINE COMPLETE — ${weekLabel}`);
        console.log(`   Total cases:     ${output.summary.total}`);
        console.log(`   ✅ Disputes:      ${output.summary.dispute_count} (${output.summary.dispute_pct}%)`);
        console.log(`   📝 Coaching:      ${output.summary.coach_count} (${output.summary.coach_pct}%)`);
        console.log(`   🔍 Reviews:       ${output.summary.review_count} (${output.summary.review_pct}%)`);
        console.log(`   🎴 Sessions:      ${output.coaching_sessions.length}`);
        console.log(`   💬 Slack msgs:    ${output.slack_messages.length}`);
        console.log(`   📄 Sheet rows:    ${output.sheet_rows.length}`);
        console.log(`${'═'.repeat(50)}\n`);
    }

    return output;
}

// ============================================================
// EXPORTS
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        runPipeline,
        buildSheetRow,
        generateCoachingUrl,
        getOrCreateProfile,
        updateProfileFromEvent,
        DRIVER_PROFILES
    };
}
