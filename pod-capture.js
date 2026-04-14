/**
 * POD Capture Utility — SPRC / DNJ4
 *
 * Extracts Photo-On-Delivery images from Amazon Logistics CDF modal
 * and uploads them to the cdf-coaching-app GitHub repo for use in
 * coaching cards.
 *
 * How it works:
 *   1. On the CDF page, click a tracking ID button → modal opens
 *   2. Expand "Photo On Delivery" section
 *   3. Extract the base64 image data from the <img> tag
 *   4. Upload to GitHub as pod_{trackingId}.jpg
 *   5. Return the GitHub Pages URL for the coaching card
 *
 * This script provides helper functions meant to be called via
 * Chrome javascript_tool during the CDF pipeline run.
 *
 * Usage (via Chrome javascript_tool):
 *   // Step 1: Extract POD base64 from current modal
 *   const podData = extractPodFromModal();
 *
 *   // Step 2: Upload to GitHub (called from pipeline)
 *   const url = await uploadPodToGitHub(trackingId, base64Data, githubToken);
 */

// ============================================================
// BROWSER-SIDE: Extract POD image from Amazon CDF modal
// ============================================================

/**
 * Extract POD image data from the currently open tracking ID modal.
 * Must be run after:
 *   1. Clicking a tracking ID button (modal is open)
 *   2. Expanding "Photo On Delivery" section
 *
 * Returns: { found: bool, base64: string|null, size: number, trackingId: string }
 */
function extractPodFromModal() {
    // Get tracking ID from modal title
    const modalTitle = document.querySelector('[class*="modal"] h2, [class*="Modal"] h2, [role="dialog"] h2');
    let trackingId = 'unknown';

    // Try to find tracking ID from the modal header text
    const headerEls = document.querySelectorAll('h2, h3, [class*="header"], [class*="title"]');
    for (const el of headerEls) {
        const match = el.textContent.match(/TBA\d+/);
        if (match) {
            trackingId = match[0];
            break;
        }
    }

    // Find the POD image (base64-encoded data URL)
    const podImg = document.querySelector('img[src^="data:image"]');

    if (!podImg) {
        return {
            found: false,
            base64: null,
            size: 0,
            trackingId: trackingId,
            error: 'No POD image found. Make sure "Photo On Delivery" section is expanded.'
        };
    }

    // Extract just the base64 portion (remove the data:image/jpeg;base64, prefix)
    const fullSrc = podImg.src;
    const base64Data = fullSrc.replace(/^data:image\/\w+;base64,/, '');

    return {
        found: true,
        base64: base64Data,
        size: base64Data.length,
        sizeKB: Math.round(base64Data.length * 0.75 / 1024),
        trackingId: trackingId,
        width: podImg.naturalWidth,
        height: podImg.naturalHeight
    };
}

/**
 * One-liner to extract just the base64 string for piping to upload.
 * Returns null if no POD found.
 */
function getPodBase64() {
    const img = document.querySelector('img[src^="data:image"]');
    return img ? img.src.replace(/^data:image\/\w+;base64,/, '') : null;
}

/**
 * Get the tracking ID from the currently open modal.
 */
function getModalTrackingId() {
    const allText = document.body.innerText;
    const match = allText.match(/Tracking ID:\s*(TBA\d+)/);
    return match ? match[1] : null;
}


// ============================================================
// PIPELINE-SIDE: Upload POD to GitHub and get the Pages URL
// ============================================================

/**
 * Upload a POD image to the cdf-coaching-app GitHub repo.
 *
 * This function is designed to be called from the pipeline
 * (not from the browser). It uses the GitHub Contents API.
 *
 * @param {string} trackingId - e.g., "TBA329738844417"
 * @param {string} base64Data - raw base64 image data (no prefix)
 * @param {string} githubToken - GitHub PAT with contents write access
 * @param {string} weekLabel - e.g., "W14" — used for folder organization
 * @returns {string} GitHub Pages URL for the uploaded image
 */
async function uploadPodToGitHub(trackingId, base64Data, githubToken, weekLabel = 'W14') {
    const owner = 'cepedabiz1';
    const repo = 'cdf-coaching-app';
    const filePath = `pods/${weekLabel}/pod_${trackingId}.jpg`;
    const pagesUrl = `https://${owner}.github.io/${repo}/${filePath}`;

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

    const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json'
        },
        body: JSON.stringify({
            message: `Add POD image for ${trackingId} (${weekLabel})`,
            content: base64Data
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`GitHub upload failed: ${response.status} ${err}`);
    }

    return pagesUrl;
}

/**
 * Convenience: Extract POD from modal + return data ready for upload.
 * Run this in the browser after opening a tracking ID modal and
 * expanding the Photo On Delivery section.
 *
 * Returns a JSON string with trackingId and base64 data.
 */
function capturePodForUpload() {
    const result = extractPodFromModal();
    if (!result.found) {
        return JSON.stringify({ success: false, error: result.error });
    }
    return JSON.stringify({
        success: true,
        trackingId: result.trackingId,
        base64: result.base64,
        sizeKB: result.sizeKB
    });
}


// ============================================================
// GIT-BASED UPLOAD (alternative to API — works from sandbox)
// ============================================================

/**
 * Save base64 POD data to a local file for git-based upload.
 * This is the preferred method since api.github.com is blocked
 * from the sandbox but git push is not.
 *
 * Usage from pipeline:
 *   1. Extract base64 from browser via javascript_tool
 *   2. Save to local file using this function
 *   3. Git add, commit, push from bash
 *
 * @param {string} base64Data - raw base64 image data
 * @param {string} trackingId - e.g., "TBA329738844417"
 * @param {string} weekLabel - e.g., "W14"
 * @param {string} repoPath - local path to the cloned repo
 * @returns {object} { localPath, gitPath, pagesUrl }
 */
function getPodFilePaths(trackingId, weekLabel = 'W14') {
    const fileName = `pod_${trackingId}.jpg`;
    const gitPath = `pods/${weekLabel}/${fileName}`;
    const pagesUrl = `https://cepedabiz1.github.io/cdf-coaching-app/${gitPath}`;

    return {
        fileName,
        gitPath,
        pagesUrl,
        directory: `pods/${weekLabel}`
    };
}


// ============================================================
// EXPORTS
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extractPodFromModal,
        getPodBase64,
        getModalTrackingId,
        uploadPodToGitHub,
        capturePodForUpload,
        getPodFilePaths
    };
}
