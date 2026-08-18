/* Connects the supplied UI to the production backend. */
(() => {
  let socket;
  let gpsWatch;
  let adminSetupKey = sessionStorage.getItem('mus_admin_setup_key') || '';
  const api = async (url, options = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (adminSetupKey) headers['x-admin-setup-key'] = adminSetupKey;
    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Server request failed.');
    return body;
  };
  const nearestPlace = (latitude, longitude) => Object.keys(places).reduce((best, place) => {
    const distance = (latitude - places[place].lat) ** 2 + (longitude - places[place].lon) ** 2;
    return distance < best.distance ? { place, distance } : best;
  }, { place: null, distance: Infinity }).place;

  function setGps(position, source) {
    const { latitude, longitude, accuracy } = position.coords;
    const place = nearestPlace(latitude, longitude);
    state.public = { ...state.public, place, gps: { latitude, longitude, accuracy, timestamp: position.timestamp } };
    save();
    if ($('#changePlace')) $('#changePlace').value = place;
    if ($('#gpsStatus')) $('#gpsStatus').textContent = `Live GPS on · accuracy ${Math.round(accuracy)}m`;
    if ($('#loginGpsStatus')) $('#loginGpsStatus').textContent = `Live GPS on · nearest known place: ${place} · ${Math.round(accuracy)}m accuracy`;
    if (source === 'dashboard') renderPublic();
    return state.public.gps;
  }

  function enableLiveGps(source) {
    if (!navigator.geolocation) return toast('Location unavailable', 'This device does not support GPS location.', true);
    const status = source === 'login' ? $('#loginGpsStatus') : $('#gpsStatus');
    status.textContent = 'Requesting precise device location…';
    navigator.geolocation.getCurrentPosition(position => {
      setGps(position, source === 'login' ? 'login' : 'dashboard');
      if (gpsWatch) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = navigator.geolocation.watchPosition(position => setGps(position, 'dashboard'), () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
      toast('Live GPS enabled', 'Your actual device location will be used for any panic alert.');
    }, () => {
      status.textContent = 'Location permission denied — enable location to use panic alert.';
      toast('Location required', 'Enable device location before sending a panic alert.', true);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  async function freshGps() {
    if (!navigator.geolocation) throw new Error('This device does not support location.');
    return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(position => resolve(setGps(position, 'dashboard')), () => reject(new Error('Precise device location permission is required for panic alert.')), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
  }

  function renderServerAlerts() {
    const tbody = $('#alertRows');
    if (!tbody) return;
    tbody.innerHTML = state.alerts.length ? state.alerts.map(alert => {
      const maps = `https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`;
      const action = alert.status === 'PENDING_OTP'
        ? `<button class="primary" style="padding:6px 8px" onclick="verifyAlert('${alert.id}')">Verify OTP</button>`
        : `<span class="badge low">${esc(alert.status)}</span>`;
      return `<tr><td>${esc(new Date(alert.createdAt).toLocaleString())}</td><td>${esc(alert.name)}</td><td>${esc(alert.phone)}</td><td>${esc(alert.place)}</td><td><a href="${maps}" target="_blank" rel="noopener">GPS (${alert.accuracyMeters}m)</a></td><td><span class="badge high">PANIC</span></td><td>${action}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">No public panic alerts received.</td></tr>';
  }

  async function loadAlerts() {
    try { state.alerts = await api('/api/alerts'); renderServerAlerts(); $('#adminAlertCount').textContent = state.alerts.length; }
    catch (error) { toast('Admin sync unavailable', error.message, true); }
  }

  window.verifyAlert = async id => {
    const otp = window.prompt('Enter the 6-digit OTP received on the admin phone:');
    if (!otp) return;
    try {
      await api(`/api/alerts/${id}/verify-otp`, { method: 'POST', body: JSON.stringify({ otp }) });
      toast('OTP verified', 'Emergency alert marked as verified. Dispatch help now.');
      loadAlerts();
    } catch (error) { toast('OTP not verified', error.message, true); }
  };

  function connectAdmin() {
    if (!state.admin || !adminSetupKey) return;
    if (socket) socket.disconnect();
    socket = io();
    socket.on('connect', () => socket.emit('admin:join', { phone: state.admin.phone, setupKey: adminSetupKey }));
    socket.on('admin:ready', loadAlerts);
    socket.on('admin:error', message => toast('Admin live alert unavailable', message, true));
    socket.on('panic:new', alert => {
      state.alerts.unshift(alert); renderServerAlerts(); $('#adminAlertCount').textContent = state.alerts.length;
      toast('NEW PANIC ALERT', `${alert.name} needs help at ${alert.place}. OTP was sent to the admin phone.`, true);
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Madurai Safety: Panic Alert', { body: `${alert.name} — ${alert.place}` });
    });
    socket.on('panic:verified', loadAlerts);
  }

  $('#loginGpsBtn').onclick = () => enableLiveGps('login');
  $('#gpsBtn').onclick = () => enableLiveGps('dashboard');
  $('#publicLoginBtn').onclick = () => {
    const name = $('#publicName').value.trim();
    const phone = $('#publicPhone').value.trim();
    if (!name || !phone) return toast('Details required', 'Please enter name and mobile number.', true);
    const selected = state.public?.gps ? state.public.place : $('#publicPlace').value;
    if (!selected || selected === '__other__') return toast('Enable location', 'Please enable device location to continue.', true);
    state.public = { ...state.public, name, phone, place: selected };
    save(); $('#changePlace').value = selected; showScreen('publicApp'); renderPublic();
    if (state.public.gps) $('#gpsStatus').textContent = `Live GPS on · accuracy ${Math.round(state.public.gps.accuracy)}m`;
  };
  $('#adminLoginBtn').onclick = async () => {
    const name = $('#adminName').value.trim();
    const phone = $('#adminPhone').value.trim();
    const password = $('#adminPassword').value;
    if (!name || !phone || password !== 'urbansafety') return toast('Login failed', 'Enter name, phone and the correct dashboard password.', true);
    if (!adminSetupKey) adminSetupKey = window.prompt('Enter the ADMIN_SETUP_KEY configured on the server:') || '';
    if (!adminSetupKey) return toast('Setup key required', 'The backend setup key is needed to register this admin device.', true);
    try {
      await api('/api/admins/register', { method: 'POST', body: JSON.stringify({ name, phone, setupKey: adminSetupKey }) });
      sessionStorage.setItem('mus_admin_setup_key', adminSetupKey);
      state.admin = { name, phone }; save(); showScreen('adminApp'); renderAdmin(); renderServerAlerts(); connectAdmin();
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      toast('Admin dashboard connected', 'This device will receive live panic alerts.');
    } catch (error) { toast('Admin setup failed', error.message, true); }
  };
  $('#panicConfirmBtn').onclick = async () => {
    $('#panicConfirm').classList.remove('show');
    try {
      if (!state.public) throw new Error('Please sign in before sending an alert.');
      const gps = await freshGps();
      const result = await api('/api/panic', { method: 'POST', body: JSON.stringify({
        name: state.public.name, phone: state.public.phone, place: state.public.place,
        latitude: gps.latitude, longitude: gps.longitude, accuracyMeters: gps.accuracy, locationTimestamp: gps.timestamp
      }) });
      const alert = result.alert;
      state.alerts.unshift(alert); save();
      $('#exitRoute').innerHTML = `<b>${places[state.public.place].exit}</b><br>Live GPS alert sent. Move calmly and follow security directions.`;
      $('#exitPanel').classList.add('show');
      toast('Panic alert sent', result.sms.delivered ? 'Admin received the OTP SMS and live dashboard alert.' : 'Live dashboard alert sent. SMS provider is not configured yet.', true);
    } catch (error) { toast('Panic alert not sent', error.message, true); }
  };

  if (state.admin && !adminSetupKey) adminSetupKey = window.prompt('Enter the ADMIN_SETUP_KEY to reconnect this admin device:') || '';
  if (state.admin) connectAdmin();
})();
