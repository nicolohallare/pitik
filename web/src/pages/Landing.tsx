import { Link } from 'react-router-dom';
import { Layout } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Landing() {
  const { session } = useAuth();
  return (
    <Layout>
      <section className="stack" style={{ paddingTop: 8 }}>
        <span className="who">para sa Taktak</span>
        <h1>Dumaan ka. Nakuhanan ka.</h1>
        <p className="lead">Pitik finds the roadside photos of you from the pitikeros at Taktak, using the ride you already record. No scrolling through FB albums, no Messenger.</p>
        <div className="row">
          <Link className="btn sun" to={session ? '/rider' : '/login?next=/rider'} style={{ flex: '1 1 200px' }}>Find my photos</Link>
          <Link className="btn alt" to={session ? '/pitikero' : '/login?next=/pitikero'} style={{ flex: '1 1 200px' }}>Pitikero ako</Link>
        </div>
      </section>

      <section className="card">
        <span className="who">ang rider</span>
        <h2>Connect Strava once.</h2>
        <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Every ride comes in on its own. Pitik checks if you passed a pitikero while they were shooting.</li>
          <li>You get one message per ride: a line on your Strava activity (and an email, if you signed in with one), listing every pitikero who caught you.</li>
          <li>You only see the few minutes around when you passed. Pick yours, add a tip, pay with GCash, Maya or card.</li>
        </ol>
        <p className="note">No Strava? Upload a GPX from Garmin or Wahoo, or just tell us roughly when you passed.</p>
      </section>

      <section className="card dark">
        <span className="hand" style={{ fontSize: 30, color: '#F6E3C4' }}>walang kaltas</span>
        <h2 style={{ color: 'var(--on-dark)' }}>Pitikero, sa'yo ang buong bayad.</h2>
        <p style={{ margin: 0 }}>You set your price (₱50 and up) and keep all of it, plus every tip. Riders pay a small Pitik fee on top. Bayad sa GCash mo tuwing Lunes, may ref number at resibo.</p>
        <p className="note">Tap "Nandito ako" at your spot, shoot like you always do, upload when you're home.</p>
      </section>

      <section className="card flat">
        <h3>Privacy, plainly</h3>
        <p className="note" style={{ color: 'var(--ink2)', fontSize: 14 }}>Pitik keeps only the moments your ride passed a pitikero, never your full route after matching. No face scanning. Photos of you are shown only to you. Disconnect Strava anytime.</p>
      </section>
    </Layout>
  );
}
