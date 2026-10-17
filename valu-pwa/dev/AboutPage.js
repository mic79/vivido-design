export default {
  emits: ['go-home', 'navigate'],

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
        <div class="subpage-nav">
          <button class="subpage-back" @click="$emit('go-home')">
            <span class="material-icons">arrow_back</span>
          </button>
          <div class="valu-orb-sm subpage-orb" @click="$emit('navigate', 'assistant')">
            <div class="spheres">
              <div class="spheres-group">
                <div class="sphere s1"></div>
                <div class="sphere s2"></div>
                <div class="sphere s3"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="subpage-header">
          <h1 class="subpage-title">About</h1>
        </div>

        <div style="padding:0 16px 24px;">
          <div class="card mb-16">
            <div class="card-body">
              <p style="font-size:14px;line-height:1.6;color:var(--color-text);">
                <strong>Valu</strong> helps you organize your personal financial data, securely and privately.
              </p>
              <p style="font-size:14px;line-height:1.6;color:var(--color-text-secondary);margin-top:8px;">
                Track expenses, income, and account balances across multiple groups. Set category goals, view spending trends,
                and get monthly summaries — all stored in your own Google Drive.
              </p>
            </div>
          </div>

          <div class="card mb-16">
            <div class="card-header"><h3>Privacy</h3></div>
            <div class="card-body">
              <p style="font-size:14px;line-height:1.6;color:var(--color-text-secondary);">
                Your data is stored exclusively in Google Sheets on your own Google Drive. Valu never sends your financial data to any external server.
                The app runs entirely in your browser — even the Valu assistant works 100% on-device with no cloud AI.
              </p>
            </div>
          </div>

          <div class="card mb-16">
            <div class="card-header"><h3>How it works</h3></div>
            <div class="card-body">
              <div class="about-feature">
                <span class="material-icons about-feature-icon">folder</span>
                <div>
                  <strong>Your data, your Drive</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Each group creates a spreadsheet in your Google Drive. You own and control it.
                  </p>
                </div>
              </div>
              <div class="about-feature">
                <span class="material-icons about-feature-icon">auto_awesome</span>
                <div>
                  <strong>Smart Insights</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Get spending estimates from balance changes and income — ~80% of the picture with ~10% of the effort.
                  </p>
                </div>
              </div>
              <div class="about-feature">
                <span class="material-icons about-feature-icon">chat_bubble_outline</span>
                <div>
                  <strong>Valu assistant</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Tap the orb on any page to ask questions about your finances, get summaries, and navigate the app.
                  </p>
                </div>
              </div>
              <div class="about-feature">
                <span class="material-icons about-feature-icon">people</span>
                <div>
                  <strong>Shared groups</strong>
                  <p style="font-size:14px;color:var(--color-text-secondary);margin-top:2px;">
                    Share a Google Sheet with someone and both of you can use Valu with the same data.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
