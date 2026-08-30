/**
 * Global Image Pan & Zoom Lightbox Viewer for 3KS Playground
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Create Modal DOM if not present
  let modalHtml = `
    <div id="imageViewerModal" class="image-viewer-backdrop" style="display: none;">
      <!-- Controls Toolbar -->
      <div class="image-viewer-toolbar">
        <button type="button" class="btn btn-dark btn-sm rounded-pill text-white" id="ivZoomIn" title="Zoom In">
          <i class="bi bi-zoom-in"></i>
        </button>
        <button type="button" class="btn btn-dark btn-sm rounded-pill text-white" id="ivZoomOut" title="Zoom Out">
          <i class="bi bi-zoom-out"></i>
        </button>
        <button type="button" class="btn btn-dark btn-sm rounded-pill text-white" id="ivReset" title="Reset View">
          <i class="bi bi-arrows-fullscreen"></i>
        </button>
        <button type="button" class="btn btn-danger btn-sm rounded-circle" id="ivClose" title="Close Preview">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>

      <!-- Image Pan Canvas -->
      <div class="image-viewer-canvas" id="ivCanvas">
        <img src="" alt="Preview" id="ivImage" class="image-viewer-img">
      </div>

      <div class="image-viewer-hint">
        <small><i class="bi bi-hand-index-thumb me-1"></i>Pinch or drag to pan & zoom • Double-tap to zoom</small>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('imageViewerModal');
  const img = document.getElementById('ivImage');
  const canvas = document.getElementById('ivCanvas');
  const btnZoomIn = document.getElementById('ivZoomIn');
  const btnZoomOut = document.getElementById('ivZoomOut');
  const btnReset = document.getElementById('ivReset');
  const btnClose = document.getElementById('ivClose');

  let scale = 1;
  let posX = 0;
  let posY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialPinchDistance = null;

  function updateTransform() {
    img.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`;
  }

  function resetTransform() {
    scale = 1;
    posX = 0;
    posY = 0;
    updateTransform();
  }

  function openViewer(src) {
    if (!src) return;
    img.src = src;
    resetTransform();
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeViewer() {
    modal.style.display = 'none';
    img.src = '';
    document.body.style.overflow = '';
  }

  // Zoom In / Out
  btnZoomIn.addEventListener('click', (e) => {
    e.stopPropagation();
    scale = Math.min(scale + 0.5, 4);
    updateTransform();
  });

  btnZoomOut.addEventListener('click', (e) => {
    e.stopPropagation();
    scale = Math.max(scale - 0.5, 0.5);
    updateTransform();
  });

  btnReset.addEventListener('click', (e) => {
    e.stopPropagation();
    resetTransform();
  });

  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeViewer();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target === canvas) {
      closeViewer();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closeViewer();
    }
  });

  // Mouse Drag / Pan
  img.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    startX = e.clientX - posX;
    startY = e.clientY - posY;
    img.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    posX = e.clientX - startX;
    posY = e.clientY - startY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      img.style.cursor = 'grab';
    }
  });

  // Mouse Wheel Zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    scale = Math.min(Math.max(0.5, scale + delta), 4);
    updateTransform();
  }, { passive: false });

  // Touch Events (Pinch-to-zoom and Pan on mobile)
  let lastTap = 0;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {
        // Double tap toggle zoom
        scale = scale > 1.2 ? 1 : 2.5;
        posX = 0;
        posY = 0;
        updateTransform();
      }
      lastTap = now;

      isDragging = true;
      startX = e.touches[0].clientX - posX;
      startY = e.touches[0].clientY - posY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialPinchDistance = Math.hypot(dx, dy);
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      e.preventDefault();
      posX = e.touches[0].clientX - startX;
      posY = e.touches[0].clientY - startY;
      updateTransform();
    } else if (e.touches.length === 2 && initialPinchDistance) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDistance = Math.hypot(dx, dy);
      const diff = (currentDistance - initialPinchDistance) * 0.01;
      scale = Math.min(Math.max(0.6, scale + diff), 4);
      initialPinchDistance = currentDistance;
      updateTransform();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    isDragging = false;
    initialPinchDistance = null;
  });

  // Attach click listener to all previewable images across the site
  function initImageClickables() {
    const images = document.querySelectorAll('img:not(.navbar-brand img):not(.no-zoom)');
    images.forEach(image => {
      image.style.cursor = 'zoom-in';
      image.addEventListener('click', (e) => {
        // Don't trigger if image is inside a button/link that isn't for zooming
        const parentLink = image.closest('a');
        if (parentLink && parentLink.getAttribute('href') && !parentLink.getAttribute('href').startsWith('#') && !parentLink.getAttribute('href').includes('uploads')) {
          return;
        }
        if (parentLink) e.preventDefault();
        openViewer(image.src);
      });
    });
  }

  initImageClickables();
});
