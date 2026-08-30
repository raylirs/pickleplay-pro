const assert = require('assert');

async function runTests() {
  console.log('🧪 Starting PicklePlay Pro Integration & Verification Tests...');

  const { app, server } = require('../server');
  const { sequelize, User, CourtCategory, Court, Reservation } = require('../models');
  const seedDatabase = require('../seeds/seed');
  const { formatDate } = require('../utils/dateTimeUtils');

  await sequelize.authenticate();
  await seedDatabase();

  const testPort = 3055;
  const baseUrl = `http://localhost:${testPort}`;

  await new Promise((resolve) => {
    server.listen(testPort, () => {
      console.log(`[Test Server] Listening on ${baseUrl}`);
      resolve();
    });
  });

  try {
    // 1. Verify Database & Seed Data
    console.log('Test 1: Verify Seed Data (Admin User and Courts)...');
    const admin = await User.findOne({ where: { username: 'admin' } });
    assert(admin !== null, 'Admin user should exist');
    const isPasswordValid = await admin.validPassword('admin123');
    assert(isPasswordValid === true, 'Admin password should match admin123');

    const categories = await CourtCategory.findAll({ include: [{ model: Court, as: 'courts' }] });
    assert(categories.length > 0, 'Court categories should be seeded');
    assert(categories[0].courts.length > 0, 'Courts should be generated for category');
    console.log(`  ✓ Found ${categories.length} court categories and ${categories.reduce((acc, c) => acc + c.courts.length, 0)} courts.`);

    const sampleCourt = categories[0].courts[0];
    const today = formatDate(new Date());

    // 2. Test Public Courts API
    console.log('Test 2: GET /api/courts ...');
    const courtsRes = await fetch(`${baseUrl}/api/courts`, { headers: { 'Accept': 'application/json' } });
    const courtsData = await courtsRes.json();
    assert(courtsData.success === true, 'GET /api/courts should return success: true');
    console.log('  ✓ Public courts API working.');

    // 3. Test Availability API
    console.log(`Test 3: GET /api/courts/${sampleCourt.id}/availability?date=${today} ...`);
    const availRes = await fetch(`${baseUrl}/api/courts/${sampleCourt.id}/availability?date=${today}`);
    const availData = await availRes.json();
    assert(availData.success === true, 'Availability API should return success: true');
    assert(Array.isArray(availData.data.slots), 'Slots should be an array');
    console.log(`  ✓ Loaded ${availData.data.slots.length} time slots for court.`);

    // 4. Test Slot Range Check
    console.log('Test 4: POST /api/reservations/check-availability ...');
    const checkRes = await fetch(`${baseUrl}/api/reservations/check-availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        court_id: sampleCourt.id,
        date: today,
        start_time: '14:00',
        total_hours: 2
      })
    });
    const checkData = await checkRes.json();
    assert(checkData.success === true, 'Check availability should succeed');
    assert(checkData.isAvailable === true, 'Slot should initially be available');
    console.log('  ✓ Slot range check API verified.');

    // 5. Test Creating a Reservation
    console.log('Test 5: POST /reservations (create reservation)...');
    const bookingRes = await fetch(`${baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        court_id: sampleCourt.id,
        user_name: 'Test Player Alpha',
        user_contact: '09171234567',
        user_email: 'alpha@example.com',
        reservation_date: today,
        start_time: '14:00',
        total_hours: 2,
        special_requests: 'Paddles needed'
      })
    });
    const bookingData = await bookingRes.json();
    assert(bookingData.success === true, 'Reservation creation should succeed');
    assert(bookingData.referenceNumber, 'Should return reference number');
    console.log(`  ✓ Reservation created successfully! Ref: ${bookingData.referenceNumber}`);

    // 6. Test Slot is now locked (conflict test)
    console.log('Test 6: Verify booked slot is locked against double booking...');
    const conflictCheckRes = await fetch(`${baseUrl}/api/reservations/check-availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        court_id: sampleCourt.id,
        date: today,
        start_time: '15:00', // overlaps with 14:00-16:00
        total_hours: 1
      })
    });
    const conflictData = await conflictCheckRes.json();
    assert(conflictData.isAvailable === false, 'Overlapping slot must NOT be available');
    console.log('  ✓ Double booking prevented properly.');

    // 7. Test GCash Payment Simulation
    console.log('Test 7: POST /payment/gcash-mock-pay (Simulate GCash payment)...');
    const payRes = await fetch(`${baseUrl}/payment/gcash-mock-pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        reference_number: bookingData.referenceNumber,
        gcash_mobile: '9171234567',
        otp: '584920',
        mpin: '1234'
      }),
      redirect: 'manual'
    });
    assert(payRes.status === 302, 'Payment should redirect on success');

    // 8. Verify Status is now CONFIRMED
    console.log('Test 8: GET /api/reservations/:ref/status (verify status)...');
    const statusRes = await fetch(`${baseUrl}/api/reservations/${bookingData.referenceNumber}/status`);
    const statusData = await statusRes.json();
    assert(statusData.status === 'CONFIRMED', `Status must be CONFIRMED, got ${statusData.status}`);
    console.log('  ✓ Payment processed and reservation marked CONFIRMED.');

    // 9. Test GCash Webhook Endpoint
    console.log('Test 9: POST /webhook/gcash-payment (Webhook verification)...');
    const bookingRes2 = await fetch(`${baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        court_id: sampleCourt.id,
        user_name: 'Test Webhook Player',
        user_contact: '09187654321',
        reservation_date: today,
        start_time: '18:00',
        total_hours: 1
      })
    });
    const bookingData2 = await bookingRes2.json();

    const webhookRes = await fetch(`${baseUrl}/webhook/gcash-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference_number: bookingData2.referenceNumber,
        transaction_id: 'GCASH-WH-TXN-9988',
        status: 'PAID'
      })
    });
    const webhookData = await webhookRes.json();
    assert(webhookData.success === true, 'Webhook should return success: true');

    const statusRes2 = await fetch(`${baseUrl}/api/reservations/${bookingData2.referenceNumber}/status`);
    const statusData2 = await statusRes2.json();
    assert(statusData2.status === 'CONFIRMED', 'Reservation should be CONFIRMED via webhook');
    console.log('  ✓ Webhook processing verified successfully.');

    console.log('\n======================================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED WITH 100% SUCCESS!');
    console.log('======================================================');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit(process.exitCode || 0);
  }
}

runTests();
