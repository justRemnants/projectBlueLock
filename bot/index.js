// 1. DYNAMIC CONFIGURATION FETCH
    let currentUser = null;
    let supabaseClient = null;

    async function initApp() {
      try {
        // Fetch public Supabase variables and Client ID from Vercel securely on load
        const configResponse = await fetch('/api/config');
        const config = await configResponse.json();

        // Initialize Supabase Client dynamically
        supabaseClient = supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

        // Configure the Discord OAuth redirection URL dynamically
        const host = window.location.host;
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const redirectUri = encodeURIComponent(`${protocol}://${host}/`);
        const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${config.discordClientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;

        // Initialize session authorization
        await initAuth(discordAuthUrl);

      } catch (err) {
        console.error('[App Initialization Failure]:', err.message);
      }
    }

    // 2. SECURE AUTHENTICATION STATE MACHINE
    async function initAuth(discordAuthUrl) {
      const authWidget = document.getElementById('auth-widget');
      const token = localStorage.getItem('bluelock_token');
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');

      // Handle OAuth Redirect Handshake from Discord
      if (code) {
        authWidget.innerHTML = `<span class="text-xs text-slate-400 font-mono"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Exchanging Handshake...</span>`;
        try {
          const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
          });
          const data = await response.json();
          
          if (data.token) {
            localStorage.setItem('bluelock_token', data.token);
            currentUser = data.user;
          }
        } catch (err) {
          console.error('[OAuth Handshake Failure]:', err);
        }
        
        // Clean URL query parameters so the ?code= is removed from the address bar
        window.history.replaceState({}, document.title, window.location.pathname);
      } 
      // Handle Auto-login using an existing local token
      else if (token) {
        try {
          const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });
          if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
          } else {
            // Clear invalid or expired tokens
            localStorage.removeItem('bluelock_token');
          }
        } catch (err) {
          console.error('[Session Verification Failure]:', err);
          localStorage.removeItem('bluelock_token');
        }
      }

      renderAuthUI(discordAuthUrl);
    }

    // 3. RENDER AUTH WIDGET
    function renderAuthUI(discordAuthUrl) {
      const authWidget = document.getElementById('auth-widget');
      
      if (currentUser) {
        const avatarUrl = currentUser.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png';
        authWidget.innerHTML = `
          <div class="flex items-center space-x-3 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl">
            <img src="${avatarUrl}" class="h-6 w-6 rounded-full border border-brand-500" alt="Avatar">
            <div class="text-left hidden sm:block">
              <p class="text-xs font-bold text-white line-clamp-1 leading-none">${currentUser.display_name || currentUser.username}</p>
              <p class="text-[10px] text-brand-500 font-mono leading-none mt-1">${currentUser.tokens_balance.toLocaleString()} 🪙</p>
            </div>
            <button onclick="logout('${discordAuthUrl}')" class="text-slate-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-800 transition" title="Log Out">
              <i class="fa-solid fa-right-from-bracket"></i>
            </button>
          </div>
        `;
      } else {
        authWidget.innerHTML = `
          <a href="${discordAuthUrl}" class="bg-brand-500 hover:bg-brand-600 active:scale-95 text-white text-xs font-bold px-4 py-2 rounded-xl flex items-center space-x-2 transition shadow-lg shadow-brand-500/20">
            <i class="fa-brands fa-discord text-sm"></i>
            <span>Login with Discord</span>
          </a>
        `;
      }

      // Trigger custom events so other dashboard components know the auth state is ready
      document.dispatchEvent(new CustomEvent('bluelock_auth_ready', { detail: currentUser }));
    }

    function logout(discordAuthUrl) {
      localStorage.removeItem('bluelock_token');
      currentUser = null;
      renderAuthUI(discordAuthUrl);
    }

    // Run App Initializer on DOM Load
    window.addEventListener('DOMContentLoaded', initApp);