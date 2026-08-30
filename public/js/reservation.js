document.addEventListener('DOMContentLoaded', () => {
  const courtSelect = document.getElementById('courtSelect');
  const dateSelect = document.getElementById('dateSelect');
  const durationSelect = document.getElementById('durationSelect');
  const slotsGrid = document.getElementById('slotsGrid');
  const selectedStartTimeInput = document.getElementById('selectedStartTime');
  const slotLoadingText = document.getElementById('slotLoadingText');
  const submitBtn = document.getElementById('submitBtn');
  const conflictAlert = document.getElementById('conflictAlert');
  const conflictMessage = document.getElementById('conflictMessage');

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

  function checkRangeAvailability(startIndex, duration) {
    let conflictingSlot = null;
    for (let i = 0; i < duration; i++) {
      const nextSlot = currentSlots[startIndex + i];
      if (!nextSlot || !nextSlot.isAvailable) {
        conflictingSlot = nextSlot || { startLabel: 'Beyond closing time' };
        break;
      }
    }
    return {
      isAvailable: !conflictingSlot,
      conflictingSlot
    };
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
      const check = checkRangeAvailability(index, duration);
      const isAvailable = check.isAvailable;
      const isSelected = selectedStart === slot.startTime;

      const col = document.createElement('div');
      col.className = 'col-6 col-md-4 col-lg-3';

      const btn = document.createElement('div');
      btn.className = `slot-btn text-center ${isAvailable ? 'available' : 'booked'} ${isSelected ? 'selected' : ''}`;
      
      btn.innerHTML = `
        <div class="fw-bold">${slot.startLabel}</div>
        <div class="small opacity-75">${isAvailable ? 'Available' : 'Booked'}</div>
      `;

      if (isAvailable) {
        btn.addEventListener('click', () => {
          selectedStartTimeInput.value = slot.startTime;
          if (conflictAlert) conflictAlert.style.display = 'none';
          renderSlots();
          updateSummary();
        });
      } else {
        btn.addEventListener('click', () => {
          if (conflictAlert && conflictMessage) {
            conflictAlert.style.display = 'block';
            conflictMessage.textContent = `Cannot book from ${slot.startLabel} for ${duration} hour(s): Conflict at ${check.conflictingSlot.startLabel || 'booked slot'}.`;
          }
        });
      }

      col.appendChild(btn);
      slotsGrid.appendChild(col);
    });

    // Check if the currently selected slot is valid for the selected duration
    const currentIdx = currentSlots.findIndex(s => s.startTime === selectedStartTimeInput.value);
    if (currentIdx !== -1) {
      const check = checkRangeAvailability(currentIdx, duration);
      if (!check.isAvailable) {
        if (conflictAlert && conflictMessage) {
          conflictAlert.style.display = 'block';
          conflictMessage.textContent = `Warning: ${duration}-hour booking from ${formatTime12(selectedStartTimeInput.value)} conflicts with an already booked slot at ${check.conflictingSlot.startLabel}. Please pick another time or reduce duration.`;
        }
        if (submitBtn) submitBtn.disabled = true;
      } else {
        if (conflictAlert) conflictAlert.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    updateSummary();
  }

  function updateSummary() {
    const selectedOption = courtSelect.options[courtSelect.selectedIndex];
    const courtName = selectedOption ? selectedOption.getAttribute('data-name') : 'Court';
    const pricePerHour = parseFloat(selectedOption ? selectedOption.getAttribute('data-price') : 350) || 350;
    const duration = parseInt(durationSelect.value, 10) || 1;
    const date = dateSelect.value;
    const startTime = selectedStartTimeInput.value;

    if (summaryCourtName) summaryCourtName.textContent = courtName;
    if (summaryDate) summaryDate.textContent = date || '-';
    if (summaryDuration) summaryDuration.textContent = `${duration} Hour${duration > 1 ? 's' : ''}`;
    if (summaryRate) summaryRate.textContent = formatCurrency(pricePerHour);

    if (startTime) {
      const currentIdx = currentSlots.findIndex(s => s.startTime === startTime);
      const isRangeAvailable = currentIdx !== -1 ? checkRangeAvailability(currentIdx, duration).isAvailable : false;

      const endTime = addHoursToTime(startTime, duration);
      if (summaryTimeSlot) summaryTimeSlot.textContent = `${formatTime12(startTime)} - ${formatTime12(endTime)}`;
      const total = pricePerHour * duration;
      if (summaryTotal) summaryTotal.textContent = formatCurrency(total);
      
      if (submitBtn) {
        submitBtn.disabled = !isRangeAvailable;
      }
    } else {
      if (summaryTimeSlot) summaryTimeSlot.textContent = 'No slot selected';
      if (summaryTotal) summaryTotal.textContent = '₱0.00';
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  courtSelect.addEventListener('change', () => {
    if (conflictAlert) conflictAlert.style.display = 'none';
    fetchSlots();
  });

  dateSelect.addEventListener('change', () => {
    if (conflictAlert) conflictAlert.style.display = 'none';
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
