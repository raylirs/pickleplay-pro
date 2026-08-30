document.addEventListener('DOMContentLoaded', () => {
  const courtSelect = document.getElementById('courtSelect');
  const dateSelect = document.getElementById('dateSelect');
  const durationSelect = document.getElementById('durationSelect');
  const slotsGrid = document.getElementById('slotsGrid');
  const selectedStartTimeInput = document.getElementById('selectedStartTime');
  const slotLoadingText = document.getElementById('slotLoadingText');
  const submitBtn = document.getElementById('submitBtn');

  // Summary elements
  const summaryCourtName = document.getElementById('summaryCourtName');
  const summaryDate = document.getElementById('summaryDate');
  const summaryTimeSlot = document.getElementById('summaryTimeSlot');
  const summaryDuration = document.getElementById('summaryDuration');
  const summaryRate = document.getElementById('summaryRate');
  const summaryTotal = document.getElementById('summaryTotal');

  if (!courtSelect || !slotsGrid) return;

  let currentSlots = [];

  function formatTime12(time24) {
    if (!time24) return '';
    const [hStr, mStr] = time24.split(':');
    let hour = parseInt(hStr, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    hour = hour ? hour : 12;
    return `${hour}:${mStr} ${ampm}`;
  }

  function addHoursToTime(timeStr, hours) {
    const [h, m] = timeStr.split(':').map(Number);
    const newHour = h + parseInt(hours, 10);
    return `${String(newHour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function formatCurrency(amount) {
    const num = parseFloat(amount) || 0;
    return '₱' + num.toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  async function fetchSlots() {
    const courtId = courtSelect.value;
    const date = dateSelect.value;
    if (!courtId || !date) return;

    if (slotLoadingText) slotLoadingText.style.display = 'inline-block';
    slotsGrid.innerHTML = '<div class="col-12 py-3 text-center text-muted small"><i class="bi bi-arrow-repeat spin me-1"></i>Loading available time slots...</div>';

    try {
      const res = await fetch(`/api/courts/${courtId}/availability?date=${date}`);
      const data = await res.json();
      if (slotLoadingText) slotLoadingText.style.display = 'none';

      if (data.success && data.data && data.data.slots) {
        currentSlots = data.data.slots;
        renderSlots();
      } else {
        slotsGrid.innerHTML = '<div class="col-12 text-center text-danger small py-3">Could not load slots.</div>';
      }
    } catch (err) {
      if (slotLoadingText) slotLoadingText.style.display = 'none';
      slotsGrid.innerHTML = '<div class="col-12 text-center text-danger small py-3">Failed to load court availability.</div>';
    }
  }

  function renderSlots() {
    const selectedStart = selectedStartTimeInput.value;
    const duration = parseInt(durationSelect.value, 10) || 1;

    slotsGrid.innerHTML = '';

    if (!currentSlots || currentSlots.length === 0) {
      slotsGrid.innerHTML = '<div class="col-12 text-center text-muted small py-3">No slots found for this date.</div>';
      return;
    }

    currentSlots.forEach((slot, index) => {
      let canBookRange = true;
      for (let i = 0; i < duration; i++) {
        const nextSlot = currentSlots[index + i];
        if (!nextSlot || !nextSlot.isAvailable) {
          canBookRange = false;
          break;
        }
      }

      const col = document.createElement('div');
      col.className = 'col-sm-6 col-md-4 col-lg-3';

      const isSelected = selectedStart === slot.startTime && canBookRange;
      const isAvailable = canBookRange;

      const btn = document.createElement('div');
      btn.className = `slot-btn text-center ${isAvailable ? 'available' : 'booked'} ${isSelected ? 'selected' : ''}`;
      
      btn.innerHTML = `
        <div class="fw-bold">${slot.startLabel}</div>
        <div class="small opacity-75">${isAvailable ? 'Available' : 'Booked'}</div>
      `;

      if (isAvailable) {
        btn.addEventListener('click', () => {
          selectedStartTimeInput.value = slot.startTime;
          renderSlots();
          updateSummary();
        });
      }

      col.appendChild(btn);
      slotsGrid.appendChild(col);
    });

    const currentValid = currentSlots.some((s, idx) => {
      if (s.startTime !== selectedStartTimeInput.value) return false;
      for (let i = 0; i < duration; i++) {
        if (!currentSlots[idx + i] || !currentSlots[idx + i].isAvailable) return false;
      }
      return true;
    });

    if (!currentValid) {
      const firstAvailableIdx = currentSlots.findIndex((s, idx) => {
        for (let i = 0; i < duration; i++) {
          if (!currentSlots[idx + i] || !currentSlots[idx + i].isAvailable) return false;
        }
        return true;
      });

      if (firstAvailableIdx !== -1) {
        selectedStartTimeInput.value = currentSlots[firstAvailableIdx].startTime;
        renderSlots();
      } else {
        selectedStartTimeInput.value = '';
      }
    }

    updateSummary();
  }

  function updateSummary() {
    const selectedOption = courtSelect.options[courtSelect.selectedIndex];
    const courtName = selectedOption ? selectedOption.getAttribute('data-name') : 'Court';
    const pricePerHour = parseFloat(selectedOption ? selectedOption.getAttribute('data-price') : 0) || 0;
    const duration = parseInt(durationSelect.value, 10) || 1;
    const date = dateSelect.value;
    const startTime = selectedStartTimeInput.value;

    if (summaryCourtName) summaryCourtName.textContent = courtName;
    if (summaryDate) summaryDate.textContent = date || '-';
    if (summaryDuration) summaryDuration.textContent = `${duration} Hour${duration > 1 ? 's' : ''}`;
    if (summaryRate) summaryRate.textContent = formatCurrency(pricePerHour);

    if (startTime) {
      const endTime = addHoursToTime(startTime, duration);
      if (summaryTimeSlot) summaryTimeSlot.textContent = `${formatTime12(startTime)} - ${formatTime12(endTime)}`;
      const total = pricePerHour * duration;
      if (summaryTotal) summaryTotal.textContent = formatCurrency(total);
      if (submitBtn) submitBtn.disabled = false;
    } else {
      if (summaryTimeSlot) summaryTimeSlot.textContent = 'No slot selected';
      if (summaryTotal) summaryTotal.textContent = '₱0.00';
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  courtSelect.addEventListener('change', () => {
    fetchSlots();
  });

  dateSelect.addEventListener('change', () => {
    fetchSlots();
  });

  durationSelect.addEventListener('change', () => {
    renderSlots();
  });

  window.refreshReservationSlots = (courtId, date) => {
    if (courtSelect.value == courtId && dateSelect.value === date) {
      fetchSlots();
    }
  };

  fetchSlots();
});
