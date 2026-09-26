import Header from '../components/Header'
import Hero from '../components/Hero'
import ProblemSection from '../components/ProblemSection'
import HowItWorksSection from '../components/HowItWorksSection'
import CockpitPreview from '../components/CockpitPreview'
import TechnologySection from '../components/TechnologySection'
import FinalCTA from '../components/FinalCTA'
import Footer from '../components/Footer'

export default function LandingPage() {
  return (
    <>
      {/* Fixed background grid */}
      <div className="fixed inset-0 pointer-events-none fintech-grid z-0 opacity-70" />

      <Header />

      <main className="relative z-10 pt-20">
        <Hero />
        <ProblemSection />
        <HowItWorksSection />
        <CockpitPreview />
        <TechnologySection />
        <FinalCTA />
      </main>

      <Footer />
    </>
  )
}
