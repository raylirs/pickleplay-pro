function formatCurrency(amount) {
  const num = parseFloat(amount) || 0;
  return '\u20B1' + num.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function formatTime12(time24) {
  if (!time24) return '';
  const parts = time24.split(':');
  const hStr = parts[0];
  const mStr = parts[1];
  let hour = parseInt(hStr, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  hour = hour ? hour : 12;
  return hour + ':' + mStr + ' ' + ampm;
}

function generateTimeSlots(start, end, intervalMinutes) {
  if (!start) start = '08:00';
  if (!end) end = '22:00';
  if (!intervalMinutes) intervalMinutes = 60;

  const slots = [];
  const startParts = start.split(':').map(Number);
  const endParts = end.split(':').map(Number);

  let currentMinutes = startParts[0] * 60 + startParts[1];
  const endMinutes = endParts[0] * 60 + endParts[1];

  while (currentMinutes + intervalMinutes <= endMinutes) {
    const slotStartH = Math.floor(currentMinutes / 60);
    const slotStartM = currentMinutes % 60;
    const slotEndH = Math.floor((currentMinutes + intervalMinutes) / 60);
    const slotEndM = (currentMinutes + intervalMinutes) % 60;

    const startTimeStr = String(slotStartH).padStart(2, '0') + ':' + String(slotStartM).padStart(2, '0');
    const endTimeStr = String(slotEndH).padStart(2, '0') + ':' + String(slotEndM).padStart(2, '0');

    slots.push({
      startTime: startTimeStr,
      endTime: endTimeStr,
      label: formatTime12(startTimeStr) + ' - ' + formatTime12(endTimeStr),
      startLabel: formatTime12(startTimeStr),
      endLabel: formatTime12(endTimeStr)
    });

    currentMinutes += intervalMinutes;
  }

  return slots;
}

function addHoursToTime(timeStr, hours) {
  const parts = timeStr.split(':').map(Number);
  const newHour = parts[0] + parseInt(hours, 10);
  return String(newHour).padStart(2, '0') + ':' + String(parts[1]).padStart(2, '0');
}

function calculateHours(startTime, endTime) {
  const sParts = startTime.split(':').map(Number);
  const eParts = endTime.split(':').map(Number);
  return (eParts[0] * 60 + eParts[1] - (sParts[0] * 60 + sParts[1])) / 60;
}

module.exports = {
  formatCurrency,
  formatDate,
  formatTime12,
  generateTimeSlots,
  addHoursToTime,
  calculateHours
};
