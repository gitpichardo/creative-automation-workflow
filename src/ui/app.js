const PRESETS = {
  resize: [
    { name: 'square-1080', transformation: [{ width: 1080, height: 1080, focus: 'auto' }] },
    { name: 'story-1080x1920', transformation: [{ width: 1080, height: 1920, focus: 'auto' }] },
    { name: 'thumb-320', transformation: [{ width: 320, height: 320, focus: 'auto', quality: 80 }] },
  ],
  ai: [
    { name: 'bg-removed', transformation: [{ aiRemoveBackground: true }] },
    { name: 'upscaled-2x', transformation: [{ aiUpscale: true }] },
  ],
};

const briefForm = document.getElementById('brief-form');
const briefError = document.getElementById('brief-error');
const variantsError = document.getElementById('variants-error');
const historyEmpty = document.getElementById('history-empty');
const submitButton = document.getElementById('submit-button');
const progressSection = document.getElementById('progress-section');
const rendersSection = document.getElementById('renders-section');
const campaignIdEl = document.getElementById('campaign-id');
const campaignStatusEl = document.getElementById('campaign-status');
const manifestLink = document.getElementById('manifest-link');
const variantTableBody = document.querySelector('#variant-table tbody');
const rendersGrid = document.getElementById('renders-grid');
const historyList = document.getElementById('history-list');

function applyPreset(key) {
  briefForm.variants.value = JSON.stringify(PRESETS[key], null, 2);
  variantsError.hidden = true;
}

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => applyPreset(button.dataset.preset));
});

// Start with a working example so the first submit never hits an empty field.
applyPreset('resize');

function pill(status) {
  return `<span class="pill pill-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

let pollHandle;

function renderVariants(campaign) {
  variantTableBody.innerHTML = '';
  for (const v of campaign.variants) {
    const row = document.createElement('tr');
    const detail = v.status === 'error' ? v.error ?? '' : v.status === 'ready' ? v.url : '';
    row.innerHTML = `
      <td>${escapeHtml(v.fileName)}</td>
      <td>${escapeHtml(v.variant)}</td>
      <td>${pill(v.status)}</td>
      <td class="detail" title="${escapeHtml(detail ?? '')}">${escapeHtml(detail ?? '')}</td>
    `;
    variantTableBody.appendChild(row);
  }

  const readyVariants = campaign.variants.filter((v) => v.status === 'ready' && v.url);
  rendersSection.hidden = readyVariants.length === 0;
  rendersGrid.innerHTML = '';
  for (const v of readyVariants) {
    const figure = document.createElement('figure');
    const isVideoGuess = /\.(mp4|webm|mov)(\?|$)/i.test(v.url);
    const media = document.createElement(isVideoGuess ? 'video' : 'img');
    media.src = v.url;
    if (isVideoGuess) {
      media.muted = true;
      media.controls = true;
    } else {
      media.loading = 'lazy';
      media.alt = `${v.fileName} - ${v.variant}`;
    }
    const caption = document.createElement('figcaption');
    caption.textContent = `${v.fileName} - ${v.variant}`;
    figure.append(media, caption);
    rendersGrid.appendChild(figure);
  }
}

async function pollCampaign(id) {
  const res = await fetch(`/campaigns/${id}`);
  if (!res.ok) return;
  const campaign = await res.json();

  const readyCount = campaign.variants.filter((v) => v.status === 'ready').length;
  campaignStatusEl.innerHTML = `${pill(campaign.status)} ${readyCount}/${campaign.variants.length || '?'} renders ready`;
  renderVariants(campaign);

  if (campaign.manifestCsv !== undefined || campaign.status !== 'running') {
    manifestLink.hidden = campaign.status === 'running';
    manifestLink.href = `/campaigns/${id}/manifest.csv`;
  }

  if (campaign.status === 'running') {
    pollHandle = setTimeout(() => pollCampaign(id), 2000);
  }
}

function showCampaign(id) {
  clearTimeout(pollHandle);
  progressSection.hidden = false;
  campaignIdEl.textContent = id;
  manifestLink.hidden = true;
  pollCampaign(id);
}

async function loadHistory() {
  const res = await fetch('/campaigns');
  if (!res.ok) return;
  const { campaigns } = await res.json();
  historyList.innerHTML = '';
  historyEmpty.hidden = campaigns.length > 0;
  for (const c of campaigns) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = c.name;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showCampaign(c.id);
    });
    const stats = document.createElement('span');
    stats.className = 'stats';
    stats.innerHTML = `${c.ready}/${c.total} ready${c.failed ? `, ${c.failed} failed` : ''} ${pill(c.status)}`;
    li.append(link, stats);
    historyList.appendChild(li);
  }
}

briefForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  briefError.hidden = true;
  variantsError.hidden = true;
  submitButton.disabled = true;

  try {
    const formData = new FormData(briefForm);
    let variants;
    try {
      variants = JSON.parse(formData.get('variants'));
    } catch {
      variantsError.textContent = 'Variants must be valid JSON. Pick a preset above to start from a working example.';
      variantsError.hidden = false;
      return;
    }

    const brief = {
      name: formData.get('name'),
      folder: formData.get('folder'),
      assetSearchQuery: formData.get('assetSearchQuery') || undefined,
      variants,
    };

    const res = await fetch('/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(brief),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error ? `${body.error} ${body.message ?? ''}`.trim() : `Request failed with ${res.status}`);
    }

    showCampaign(body.id);
    loadHistory();
  } catch (err) {
    briefError.textContent = err.message;
    briefError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

loadHistory();
