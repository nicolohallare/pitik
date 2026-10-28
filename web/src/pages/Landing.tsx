import { Link } from 'react-router-dom';
import { Layout } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Landing() {
  const { session } = useAuth();
  return (
    <Layout>
      <section className="hero" aria-labelledby="hero-h">
        <img src="/img/rider-taktak.webp" alt="A rider in a gold helmet speeding down the Taktak road" width={1100} height={1018} />
        <div className="hero-text">
          <h1 id="hero-h">You rode by. You got shot.</h1>
          <p>Pitik finds your roadside photos from the pitikeros at Taktak, using the ride you already record. No more scrolling through FB albums.</p>
        </div>
      </section>
      <div className="stack">
        <Link className="btn sun" to={session ? '/rider' : '/login?next=/rider'}>Find my photos</Link>
        <Link className="btn alt" to={session ? '/pitikero' : '/login?next=/pitikero'}>I'm a pitikero</Link>
      </div>

      <section aria-labelledby="how-h">
        <h2 id="how-h" className="sec">How it works for riders</h2>
        <ol className="road">
          <li><b>Connect Strava once</b><span>Every ride comes in on its own. No Strava? Upload a GPX file or tell us when you passed.</span></li>
          <li><b>Ride past Taktak</b><span>Pitik checks if you passed a pitikero while they were shooting.</span></li>
          <li><b>Get one message per ride</b><span>A line on your Strava activity listing every pitikero who caught you.</span></li>
          <li><b>Pick the ones you like</b><span>Previews are free. Add a tip if you want, then pay with GCash, Maya or card.</span></li>
        </ol>
      </section>

      <section className="card dark pk">
        <h2>Pitikeros keep 100%.</h2>
        <ul className="facts">
          <li><b>Your price</b><span>₱50 and up. All of it is yours, plus every tip.</span></li>
          <li><b>Paid every Monday</b><span>Straight to your GCash, with a reference number.</span></li>
          <li><b>Shoot like you always do</b><span>Tap "I'm here" at your spot, then upload when you're home.</span></li>
        </ul>
        <p className="note">Riders pay a small Pitik fee on top, so nothing comes out of your price.</p>
      </section>

      <section className="stack" style={{ gap: 6 }}>
        <h3>Privacy, plainly</h3>
        <p className="note" style={{ color: 'var(--ink2)', fontSize: 15 }}>Pitik keeps only the moments your ride passed a pitikero, never your full route. No face scanning. Photos of you are shown only to you. Disconnect Strava anytime.</p>
      </section>
    </Layout>
  );
}
