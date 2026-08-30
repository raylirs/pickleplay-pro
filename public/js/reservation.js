document.addEventListener('DOMContentLoaded', () => {
  const courtSelect = document.getElementById('courtSelect');
  const dateSelect = document.getElementById('dateSelect');
  const slotsGrid = document.getElementById('slotsGrid');
  const selectedSlotsInput = document.getElementById('selectedSlotsInput');
  const selectedStartTimeInput = document.getElementById('selectedStartTime');
  const totalHoursInput = document.getElementById('totalHoursInput');
  const slotLoadingText = document.getElementById('slotLoadingText');
  const clearSlotsBtn = document.getElementById('clearSlotsBtn');
  const submitBtn = document.getElementById('submitBtn');
  const slotFeedback = document.getElementById('slotFeedback');

  // Summary elements
  const summaryCourtName = document.getElementById('summaryCourtName');
  const summaryDate = document.getElementById('summaryDate');
  const summarySlotsList = document.getElementById('summarySlotsList');
  const summaryDuration = document.getElementById('summaryDuration');
  const summaryRate = document.getElementById('summaryRate');
  const summaryTotal = document.getElementById('summaryTotal');

  if (!courtSelect || !slotsGrid) return;

  let currentSlots = [];
  const selectedSlots = new Set();

  function formatTime12(time24) {
    if (!time24) return '';
    const [hStr, mStr] = time24.split(':');
    let hour = parseInt(hStr, 10);
    if (hour === 24 || hour === 0) return `12:${mStr} AM`;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    hour = hour ? hour : 12;
    return `${hour}:${mStr} ${ampm}`;
  }

  function formatCurrency(amount) {
    const num = parseFloat(amount) || 0;
    return '\u20B1' + num.toLocaleString('en-PH', {
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
        
        // Remove any previously selected slots that are no longer available on this date/court
        const availableStartTimes = new Set(currentSlots.filter(s => s.isAvailable).map(s => s.startTime));
        for (const slotTime of selectedSlots) {
          if (!availableStartTimes.has(slotTime)) {
            selectedSlots.delete(slotTime);
          }
        }

        renderSlots();
        updateSummary();
      } else {
        slotsGrid.innerHTML = '<div class="col-12 text-center text-danger small py-3">Could not load slots.</div>';
      }
    } catch (err) {
      if (slotLoadingText) slotLoadingText.style.display = 'none';
      slotsGrid.innerHTML = '<div class="col-12 text-center text-danger small py-3">Failed to load court availability.</div>';
    }
  }

  function renderSlots() {
    slotsGrid.innerHTML = '';

    if (!currentSlots || currentSlots.length === 0) {
      slotsGrid.innerHTML = '<div class="col-12 text-center text-muted small py-3">No slots found for this date.</div>';
      return;
    }

    currentSlots.forEach((slot) => {
      const isAvailable = slot.isAvailable;
      const isSelected = selectedSlots.has(slot.startTime);

      const col = document.createElement('div');
      col.className = 'col-6 col-md-4 col-lg-3';

      const btn = document.createElement('div');
      btn.className = `slot-btn text-center ${isAvailable ? 'available' : 'booked'} ${isSelected ? 'selected' : ''}`;
      
      btn.innerHTML = `
        <div class="d-flex flex-column align-items-center">
          <div class="fw-bold">${slot.startLabel}</div>
          <div class="small opacity-75">${isSelected ? '✓ Selected' : (isAvailable ? 'Available' : 'Booked')}</div>
        </div>
      `;

      if (isAvailable) {
        btn.addEventListener('click', () => {
          if (selectedSlots.has(slot.startTime)) {
            selectedSlots.delete(slot.startTime);
          } else {
            selectedSlots.add(slot.startTime);
          }
          renderSlots();
          updateSummary();
        });
      }

      col.appendChild(btn);
      slotsGrid.appendChild(col);
    });

    if (clearSlotsBtn) {
      clearSlotsBtn.style.display = selectedSlots.size > 0 ? 'inline-block' : 'none';
    }
  }

  function updateSummary() {
    const selectedOption = courtSelect.options[courtSelect.selectedIndex];
    const courtName = selectedOption ? selectedOption.getAttribute('data-name') : 'Court';
    const pricePerHour = parseFloat(selectedOption ? selectedOption.getAttribute('data-price') : 350) || 350;
    const date = dateSelect.value;

    const sortedSlots = Array.from(selectedSlots).sort();
    const count = sortedSlots.length;

    if (summaryCourtName) summaryCourtName.textContent = courtName;
    if (summaryDate) summaryDate.textContent = date || '-';
    if (summaryDuration) summaryDuration.textContent = `${count} Hour${count !== 1 ? 's' : ''}`;
    if (summaryRate) summaryRate.textContent = formatCurrency(pricePerHour);

    // Update slots badges in summary
    if (summarySlotsList) {
      if (count > 0) {
        summarySlotsList.innerHTML = sortedSlots.map(time => {
          const slotObj = currentSlots.find(s => s.startTime === time);
          const label = slotObj ? `${slotObj.startLabel} - ${slotObj.endLabel}` : formatTime12(time);
          return `<span class="badge bg-success-subtle text-success border border-success px-2 py-1">${label}</span>`;
        }).join(' ');
      } else {
        summarySlotsList.innerHTML = '<span class="text-muted small">None selected</span>';
      }
    }

    // Update hidden inputs
    if (selectedSlotsInput) {
      selectedSlotsInput.value = JSON.stringify(sortedSlots);
    }
    if (selectedStartTimeInput) {
      selectedStartTimeInput.value = sortedSlots.length > 0 ? sortedSlots[0] : '';
    }
    if (totalHoursInput) {
      totalHoursInput.value = count;
    }

    // Update total price and button state
    const total = pricePerHour * count;
    if (summaryTotal) summaryTotal.textContent = formatCurrency(total);

    if (submitBtn) {
      submitBtn.disabled = count === 0;
    }
    if (slotFeedback) {
      slotFeedback.style.display = count === 0 ? 'block' : 'none';
    }
  }

  if (clearSlotsBtn) {
    clearSlotsBtn.addEventListener('click', () => {
      selectedSlots.clear();
      renderSlots();
      updateSummary();
    });
  }

  courtSelect.addEventListener('change', () => {
    fetchSlots();
  });

  dateSelect.addEventListener('change', () => {
    fetchSlots();
  });

  window.refreshReservationSlots = (courtId, date) => {
    if (courtSelect.value == courtId && dateSelect.value === date) {
      fetchSlots();
    }
  };

  fetchSlots();
});
