import { Layout } from '../components/ui';

export default function Privacy() {
  return (
    <Layout>
      <h1>Privacy</h1>
      <section className="card">
        <h3>What Pitik keeps</h3>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li><b>Riders:</b> your email, and for each ride only the moments you passed a pitikero (time and spot). If you connect Strava, we read your rides to find those moments. A ride's route is kept for up to 3 days so late uploads can still be matched, then deleted.</li>
          <li><b>Pitikeros:</b> your name, price, GCash number and name (seen only by you and the Pitik team, for payouts), the spots where you checked in, and your photos.</li>
          <li><b>Payments:</b> handled by TechPay Philippines (BSP-licensed). Pitik never sees your card or wallet details.</li>
        </ul>
        <h3>What Pitik does not do</h3>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li>No face scanning. Photos are matched by time and place only.</li>
          <li>Photos of you are shown only to you, and only from the minutes around when you passed.</li>
          <li>We never sell your data or post your photos without asking.</li>
        </ul>
        <h3>Your choices</h3>
        <p style={{ margin: 0 }}>Disconnect Strava or turn off emails anytime in Account. To delete your account and data, email the Pitik team and we'll do it within 7 days.</p>
        <p className="note">Pitik is operated by Techwave. We follow the Philippine Data Privacy Act of 2012.</p>
      </section>
    </Layout>
  );
}
