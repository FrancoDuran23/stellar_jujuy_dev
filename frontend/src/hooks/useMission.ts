import { useCallback, useEffect, useState } from 'react'
import { demoMissionService } from '../services/DemoMissionService'
import { ApiMissionService } from '../services/ApiMissionService'
import type { MissionService } from '../services/MissionService'
import type { MissionState } from '../types/mission'

const apiMissionService = new ApiMissionService()

export function useMission() {
  const [activeService, setActiveService] = useState<MissionService>(demoMissionService)
  const [missionState, setMissionState] = useState<MissionState>(() =>
    demoMissionService.loadState(),
  )

  useEffect(() => {
    async function init() {
      const caps = await apiMissionService.fetchCapabilities()
      if (caps && caps.backendAvailable && caps.mode !== 'demo') {
        setActiveService(apiMissionService)
        setMissionState(apiMissionService.loadState())
      } else {
        setActiveService(demoMissionService)
        setMissionState(demoMissionService.loadState())
      }
    }
    void init()
  }, [])

  const simulate = useCallback(() => {
    setMissionState((prev) => activeService.simulateConsumption(prev))
  }, [activeService])

  const topUp = useCallback((amount: number) => {
    setMissionState((prev) => activeService.topUp(prev, amount))
  }, [activeService])

  const togglePause = useCallback(() => {
    setMissionState((prev) => activeService.togglePause(prev))
  }, [activeService])

  const complete = useCallback(() => {
    setMissionState((prev) => activeService.completeMission(prev))
  }, [activeService])

  const reset = useCallback(() => {
    activeService.resetDemo()
    setMissionState({ mission: null, events: [] })
  }, [activeService])

  return {
    mission: missionState.mission,
    events: missionState.events,
    simulate,
    topUp,
    togglePause,
    complete,
    reset,
  }
}
