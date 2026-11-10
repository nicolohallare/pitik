import { Link } from 'react-router-dom';
import { Layout } from '../components/ui';

export default function Terms() {
  return (
    <Layout>
      <h1>Terms</h1>
      <section className="card">
        <p style={{ margin: 0 }}>Pitik is a marketplace where roadside photographers ("pitikeros") at Taktak, Antipolo sell photos to the riders they shot. Pitik is operated by Techwave. By using Pitik you agree to these terms.</p>

        <h3>Riders</h3>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li>You see previews of shots taken in the few minutes you passed a pitikero. Previews are free and watermarked.</li>
          <li>When you buy a photo you pay the pitikero's price plus a Pitik fee shown before you pay. The full-size photo is yours for personal use, including posting on social media.</li>
          <li>If a purchase goes wrong, <Link to="/support">message us</Link> and we'll fix it or refund you.</li>
        </ul>

        <h3>Pitikeros</h3>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li>You keep 100% of your photo price and every tip. Payouts go to your GCash every Monday.</li>
          <li>You keep the copyright to your photos. You let Pitik show previews to the riders in them and deliver full-size files to buyers.</li>
          <li>Upload only photos you took yourself, from public roads. Don't upload photos that embarrass or endanger anyone.</li>
          <li>Pitik can pause an account that breaks these rules.</li>
        </ul>

        <h3>Strava</h3>
        <p style={{ margin: 0 }}>Connecting Strava is optional. Pitik uses it only to find when you passed a pitikero, as described in our <Link to="/privacy">Privacy</Link> page. Pitik is not made, sponsored or endorsed by Strava. Your use of Strava is governed by Strava's own terms.</p>

        <h3>Everything else</h3>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Don't misuse Pitik: no fake accounts, no scraping, no trying to see photos of other people.</li>
          <li>Pitik is offered as is. We work to keep it running and correct, but can't promise every rider will be caught or every photo will be sharp.</li>
          <li>We may update these terms. If a change matters, we'll tell you in the app first.</li>
          <li>These terms follow Philippine law.</li>
        </ul>
        <p className="note">Questions? <Link to="/support">Contact support</Link>.</p>
      </section>
    </Layout>
  );
}
