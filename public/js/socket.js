const socket = io();

function showLiveToast(message, isSuccess = true) {
  const toastEl = document.getElementById('liveToast');
  if (!toastEl) return;

  const msgSpan = document.getElementById('toastMessage');
  if (msgSpan) msgSpan.textContent = message;

  toastEl.className = `toast align-items-center text-bg-${isSuccess ? 'success' : 'primary'} border-0 shadow-lg`;
  const toast = new bootstrap.Toast(toastEl, { delay: 4000 });
  toast.show();
}

socket.on('court_availability_updated', (data) => {
  console.log('[Socket.io] Court availability updated:', data);
  showLiveToast('Slot availability updated in real-time.');

  const slotsContainer = document.getElementById('slotsContainer');
  if (slotsContainer) {
    const currentCourtId = slotsContainer.getAttribute('data-court-id');
    const currentDate = slotsContainer.getAttribute('data-date');
    if (currentCourtId == data.courtId && currentDate === data.date) {
      if (typeof window.renderCourtDetailSlots === 'function') {
        window.renderCourtDetailSlots(data.slots);
      } else {
        window.location.reload();
      }
    }
  }

  if (typeof window.refreshReservationSlots === 'function') {
    window.refreshReservationSlots(data.courtId, data.date);
  }
});

socket.on('payment_confirmed', (data) => {
  console.log('[Socket.io] Payment confirmed:', data);
  showLiveToast(`Court "${data.courtName || 'Pickleball'}" booked on ${data.date} (${data.startTime})!`);
});
