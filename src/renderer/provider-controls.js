const SOURCE_DEFAULTS = Object.freeze({
    'all-working': {
        label: 'All Working API',
        endpoint: 'http://169.58.35.69/data/all-working.txt'
    },
    'proxyscrape-free': {
        label: 'ProxyScrape Free API',
        endpoint: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text'
    }
});
document.documentElement.dataset.domProviderControls = 'loaded';

let latestState = null;
let sourceSelect = null;
let endpointInput = null;
let replayingStart = false;
let errorElement = null;
let mountObserver = null;
let preparationStatus = null;
const browserStates = new Map();

function showError(message) {
    if (!errorElement) {
        errorElement = document.createElement('div');
        errorElement.className = 'tracker-error proxy-source-error';
        document.querySelector('.tracker-controls')?.after(errorElement);
    }
    errorElement.textContent = message;
}

function clearError() {
    if (errorElement)
        errorElement.textContent = '';
}

function updateSourceCopy(label) {
    const description = document.querySelector('.seo-tracker__title p');
    if (description) {
        const text = 'Selected proxy API → direct proxy assignment → Google monitoring → challenge pause/resume → exact-host result opening → rotation.';
        if (description.textContent !== text)
            description.textContent = text;
    }
    const status = Array.from(document.querySelectorAll('.tracker-status span'))
        .find((element) => element.textContent?.trim().startsWith('Source'));
    const strong = status?.querySelector('strong');
    if (strong && strong.textContent !== label)
        strong.textContent = label;
    if (preparationStatus && latestState) {
        const preparing = Boolean(latestState.preparingBrowsers);
        preparationStatus.hidden = !preparing;
        const message = preparing
            ? `Preparing browsers: ${latestState.preparedBrowsers || 0} / ${latestState.browserCount}. You can stop preparation at any time.`
            : '';
        if (preparationStatus.textContent !== message)
            preparationStatus.textContent = message;
    }
}

function applyState(state) {
    latestState = state;
    const source = SOURCE_DEFAULTS[state.proxySource] ? state.proxySource : 'proxyscrape-free';
    if (sourceSelect && document.activeElement !== sourceSelect)
        sourceSelect.value = source;
    if (endpointInput && document.activeElement !== endpointInput)
        endpointInput.value = state.proxyApiUrl || SOURCE_DEFAULTS[source].endpoint;
    if (sourceSelect)
        sourceSelect.disabled = Boolean(state.running);
    if (endpointInput)
        endpointInput.disabled = Boolean(state.running);
    updateSourceCopy(state.proxySourceLabel || SOURCE_DEFAULTS[source].label);
}

function renderBrowserMessage(state) {
    const card = Array.from(document.querySelectorAll('.browser-card'))
        .find((element) => element.querySelector('.browser-card__header strong')?.textContent === `Browser ${state.id}`);
    const footer = card?.querySelector('.browser-card__footer');
    if (!footer)
        return;
    const failed = state.connectionStatus === 'proxy-failed' && Boolean(state.errorMessage);
    const message = failed ? state.errorMessage : state.url || 'Waiting for SEO Tracker…';
    if (footer.textContent !== message)
        footer.textContent = message;
    if (footer.title !== message)
        footer.title = message;
    footer.classList.toggle('status-bad', failed);
}

function applyBrowserState(state) {
    browserStates.set(state.id, state);
    renderBrowserMessage(state);
}

function createLabel(text, control, className) {
    const label = document.createElement('label');
    if (className)
        label.className = className;
    label.append(text, control);
    return label;
}

async function mount() {
    const controls = document.querySelector('.tracker-controls');
    if (!controls) {
        if (!mountObserver) {
            mountObserver = new MutationObserver(() => {
                if (document.querySelector('.tracker-controls')) {
                    mountObserver.disconnect();
                    mountObserver = null;
                    void mount();
                }
            });
            mountObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
    }
    if (document.querySelector('[data-dom-proxy-source]'))
        return;

    sourceSelect = document.createElement('select');
    sourceSelect.dataset.domProxySource = 'true';
    sourceSelect.setAttribute('aria-label', 'Proxy source');
    for (const [value, source] of Object.entries(SOURCE_DEFAULTS)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = source.label;
        sourceSelect.append(option);
    }

    endpointInput = document.createElement('input');
    endpointInput.type = 'url';
    endpointInput.setAttribute('aria-label', 'Proxy API URL (editable)');
    endpointInput.placeholder = 'https://proxy-provider.example/list.txt';
    endpointInput.autocomplete = 'off';
    endpointInput.spellcheck = false;

    sourceSelect.addEventListener('change', () => {
        endpointInput.value = SOURCE_DEFAULTS[sourceSelect.value].endpoint;
        latestState = {
            ...latestState,
            proxySource: sourceSelect.value,
            proxySourceLabel: SOURCE_DEFAULTS[sourceSelect.value].label,
            proxyApiUrl: endpointInput.value
        };
        updateSourceCopy(SOURCE_DEFAULTS[sourceSelect.value].label);
        clearError();
    });
    endpointInput.addEventListener('input', clearError);

    controls.prepend(
        createLabel('Proxy source', sourceSelect),
        createLabel('Proxy API URL (editable)', endpointInput, 'proxy-api-endpoint')
    );
    document.documentElement.dataset.domProviderControls = 'mounted';

    preparationStatus = document.createElement('div');
    preparationStatus.className = 'tracker-preparation';
    preparationStatus.setAttribute('role', 'status');
    preparationStatus.setAttribute('aria-live', 'polite');
    preparationStatus.hidden = true;
    document.querySelector('.tracker-status')?.after(preparationStatus);

    const state = await window.app.automation.getState();
    applyState(state);
    window.app.automation.onStateChanged(applyState);
    for (const browser of await window.app.browser.getAll())
        applyBrowserState(browser);
    window.app.browser.onStateChanged(applyBrowserState);

    // The recovered React bundle contains its original static source label.
    // Keep that text synchronized without replacing the recovered interface.
    new MutationObserver(() => {
        if (latestState)
            updateSourceCopy(latestState.proxySourceLabel || SOURCE_DEFAULTS[sourceSelect.value].label);
    }).observe(document.querySelector('.seo-tracker'), { childList: true, subtree: true, characterData: true });
    const browserArea = document.querySelector('.lite-browser-area');
    if (browserArea) {
        new MutationObserver(() => {
            for (const browser of browserStates.values())
                renderBrowserMessage(browser);
        }).observe(browserArea, { childList: true, subtree: true, characterData: true });
    }
}

document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || replayingStart || !button.textContent?.startsWith('Start SEO Tracker'))
        return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
        clearError();
        const state = await window.app.automation.configureProxy({
            source: sourceSelect.value,
            endpoint: endpointInput.value.trim()
        });
        applyState(state);
        replayingStart = true;
        button.click();
    }
    catch (error) {
        showError(error.message || String(error));
    }
    finally {
        replayingStart = false;
    }
}, true);

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
else
    void mount();
