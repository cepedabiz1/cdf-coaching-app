/**
 * Slack Notification Module — SPRC CDF Pipeline
 *
 * Posts coaching links and dispute summaries to Slack channels.
 * Phase 1: Posts to #cdf-coaching → Manager delivers to driver
 *
 * Uses Slack MCP tools (slack_send_message) when run inside Cowork.
 * Also generates message payloads for manual posting or future bot.
 */

// ============================================================
// MESSAGE FORMATTERS
// ============================================================

/**
 * Format a coaching notification for Slack
 * @param {Object} coachingSession - Generated coaching session data
 * @param {string} coachingUrl - URL to the coaching web app
 * @returns {Object} { channel, text, blocks }
 */
function formatCoachingMessage(coachingSession, coachingUrl) {
    const d = coachingSession;
    const sev = d.severity;
    const eventList = d.events_this_week.map(e =>
        `• *${e.feedback_category}*\n  📦 ${e.tracking_id} | ${e.delivery_date}\n  📍 ${e.address}`
    ).join('\n');

    const severityEmoji = {
        1: '🔵', 2: '🟡', 3: '🟠', 4: '🔴', 5: '⚫'
    };

    const emoji = severityEmoji[sev.level] || '🔵';

    const text = `${emoji} *CDF Coaching — ${d.driver.name}* | ${sev.label}\n` +
        `Session: \`${d.session_id}\`\n\n` +
        `*This Week's Events (${d.counts.events_this_week}):*\n${eventList}\n\n` +
        `*90-Day Count:* ${d.counts.events_90_day} events | ` +
        `*Next Escalation:* ${d.counts.remaining_before_next} more events\n\n` +
        `👉 *Coaching Link:* ${coachingUrl}\n\n` +
        `_Manager: Please deliver this coaching to ${d.driver.name} (in person or via text)._`;

    return {
        channel: '#cdf-coaching',
        text,
        driver_name: d.driver.name,
        session_id: d.session_id,
        severity_level: sev.level
    };
}

/**
 * Format a dispute summary for Slack
 * @param {Object} disputeCase - Classified case with dispute_submission data
 * @returns {Object} { channel, text }
 */
function formatDisputeMessage(disputeCase) {
    const sub = disputeCase.dispute_submission;
    if (!sub) return null;

    const text = `📋 *CDF Dispute Ready — ${sub.da_name}*\n` +
        `📦 TBA: \`${sub.tba}\`\n` +
        `📅 Delivery Date: ${sub.delivery_date}\n` +
        `🏷️ Reason: ${sub.dispute_reason || 'Not specified'}\n` +
        `📊 Confidence: ${sub.confidence}\n\n` +
        `*Evidence:*\n${sub.evidence_summary}\n\n` +
        `*Status:* ${sub.status}\n` +
        `_Review and approve in the Google Sheet to submit._`;

    return {
        channel: '#cdf-disputes',
        text,
        driver_name: sub.da_name,
        tracking_id: sub.tba,
        confidence: sub.confidence
    };
}

/**
 * Format a weekly summary for Slack
 * @param {Object} weeklyResults - Output from processWeeklyCases()
 * @param {string} weekLabel - e.g., "W14"
 * @returns {Object} { channel, text }
 */
function formatWeeklySummary(weeklyResults, weekLabel) {
    const s = weeklyResults.summary;

    const disputeDrivers = weeklyResults.disputes.map(d => d.driver_name);
    const coachDrivers = weeklyResults.coaching.map(d => d.driver_name);
    const reviewDrivers = weeklyResults.reviews.map(d => d.driver_name);

    // Deduplicate driver names
    const uniqueDispute = [...new Set(disputeDrivers)];
    const uniqueCoach = [...new Set(coachDrivers)];
    const uniqueReview = [...new Set(reviewDrivers)];

    let text = `📊 *CDF Weekly Summary — ${weekLabel}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Total Cases:* ${s.total}\n` +
        `✅ Disputes: ${s.dispute_count} (${s.dispute_pct}%)\n` +
        `📝 Coaching: ${s.coach_count} (${s.coach_pct}%)\n` +
        `🔍 Manual Review: ${s.review_count} (${s.review_pct}%)\n\n`;

    if (uniqueDispute.length > 0) {
        text += `*Dispute Cases (driver NOT at fault):*\n`;
        weeklyResults.disputes.forEach(d => {
            text += `• ${d.driver_name} — ${d.feedback_category} | \`${d.tracking_id}\`\n`;
        });
        text += '\n';
    }

    if (uniqueCoach.length > 0) {
        text += `*Coaching Required:*\n`;
        weeklyResults.coaching.forEach(d => {
            text += `• ${d.driver_name} — ${d.feedback_category} | \`${d.tracking_id}\`\n`;
        });
        text += '\n';
    }

    if (uniqueReview.length > 0) {
        text += `*Needs Manual Review:*\n`;
        weeklyResults.reviews.forEach(d => {
            text += `• ${d.driver_name} — ${d.feedback_category} | \`${d.tracking_id}\`\n`;
        });
        text += '\n';
    }

    text += `_Run completed: ${new Date().toLocaleString()}_`;

    return {
        channel: '#cdf-coaching',
        text,
        week: weekLabel,
        summary: s
    };
}

/**
 * Format a manual review alert
 * @param {Object} reviewCase - Case that needs human judgment
 * @returns {Object} { channel, text }
 */
function formatReviewAlert(reviewCase) {
    const flagList = reviewCase.review_flags.map(f => `  ⚠️ ${f}`).join('\n');
    const reasonList = reviewCase.reasons.map(r => `  • ${r}`).join('\n');

    const text = `🔍 *Manual Review Needed — ${reviewCase.driver_name}*\n` +
        `📦 TBA: \`${reviewCase.tracking_id}\`\n` +
        `📅 ${reviewCase.delivery_date}\n` +
        `🏷️ ${reviewCase.feedback_category}\n\n` +
        `*Review Flags:*\n${flagList}\n\n` +
        `*Analysis So Far:*\n${reasonList}\n\n` +
        `*Scores:* Dispute ${reviewCase.dispute_score} | Coach ${reviewCase.coach_score}\n\n` +
        `_Please investigate and classify this case manually._`;

    return {
        channel: '#cdf-coaching',
        text,
        driver_name: reviewCase.driver_name,
        tracking_id: reviewCase.tracking_id
    };
}

// ============================================================
// SLACK SENDER (via Cowork MCP tools)
// ============================================================

/**
 * Send all Slack notifications for a weekly run
 * @param {Object} weeklyResults - Output from processWeeklyCases()
 * @param {Array} coachingSessions - Generated coaching session data
 * @param {string} weekLabel - e.g., "W14"
 * @param {string} baseCoachingUrl - Base URL for coaching app
 * @param {Function} slackSendFn - The slack_send_message MCP function
 * @returns {Object} { sent, errors }
 */
async function sendWeeklyNotifications(weeklyResults, coachingSessions, weekLabel, baseCoachingUrl, slackSendFn) {
    const sent = [];
    const errors = [];

    // 1. Post weekly summary first
    try {
        const summary = formatWeeklySummary(weeklyResults, weekLabel);
        await slackSendFn({ channel: summary.channel, text: summary.text });
        sent.push({ type: 'summary', channel: summary.channel });
    } catch (err) {
        errors.push({ type: 'summary', error: err.message });
    }

    // 2. Post individual coaching notifications
    for (const session of coachingSessions) {
        try {
            const url = `${baseCoachingUrl}?session=${session.session_id}`;
            const msg = formatCoachingMessage(session, url);
            await slackSendFn({ channel: msg.channel, text: msg.text });
            sent.push({ type: 'coaching', driver: msg.driver_name, session: msg.session_id });
        } catch (err) {
            errors.push({ type: 'coaching', driver: session.driver.name, error: err.message });
        }
    }

    // 3. Post dispute summaries
    for (const dispute of weeklyResults.disputes) {
        try {
            const msg = formatDisputeMessage(dispute);
            if (msg) {
                await slackSendFn({ channel: msg.channel, text: msg.text });
                sent.push({ type: 'dispute', driver: msg.driver_name, tracking: msg.tracking_id });
            }
        } catch (err) {
            errors.push({ type: 'dispute', driver: dispute.driver_name, error: err.message });
        }
    }

    // 4. Post review alerts
    for (const review of weeklyResults.reviews) {
        try {
            const msg = formatReviewAlert(review);
            await slackSendFn({ channel: msg.channel, text: msg.text });
            sent.push({ type: 'review', driver: msg.driver_name });
        } catch (err) {
            errors.push({ type: 'review', driver: review.driver_name, error: err.message });
        }
    }

    return { sent, errors, total_sent: sent.length, total_errors: errors.length };
}

// ============================================================
// EXPORTS
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatCoachingMessage,
        formatDisputeMessage,
        formatWeeklySummary,
        formatReviewAlert,
        sendWeeklyNotifications
    };
} else {
    window.SlackNotifier = {
        formatCoachingMessage,
        formatDisputeMessage,
        formatWeeklySummary,
        formatReviewAlert,
        sendWeeklyNotifications
    };
}
