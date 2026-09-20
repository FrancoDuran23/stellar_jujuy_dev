/**
 * Módulo 1: Medidor y Conectividad (Demo / Prototipo Inicial)
 * 
 * Este script simula la captura y conteo de bytes de tráfico de red (Capa 3 / VPN)
 * e integra la solicitud de vales acumulativos (vouchers) contra el agente de pagos MPP.
 */

export interface MeterConfig {
  /** Tamaño de cada tanda/bloque de datos en bytes (ej: 1 MB = 1,048,576 bytes) */
  chunkSizeBytes: number;
  /** Límite máximo de cuota permitida sin un nuevo vale válido */
  maxUnpaidQuotaBytes: number;
}

export class NetworkDataMeter {
  private cumulativeBytes: number = 0;
  private paidQuotaBytes: number = 0;
  private isConnectionActive: boolean = true;
  private config: MeterConfig;

  constructor(config?: Partial<MeterConfig>) {
    this.config = {
      chunkSizeBytes: config?.chunkSizeBytes ?? 1_048_576, // 1 MiB por defecto
      maxUnpaidQuotaBytes: config?.maxUnpaidQuotaBytes ?? 1_048_576,
    };
  }

  /**
   * Simula la llegada/envío de paquetes de datos a través del túnel (WireGuard / Proxy)
   * @param bytesTransferred Cantidad de bytes consumidos en esta ráfaga de red
   */
  public recordTraffic(bytesTransferred: number): {
    cumulativeBytes: number;
    isQuotaAvailable: boolean;
  } {
    if (!this.isConnectionActive) {
      console.warn(' [MEDIDOR] El tráfico está CORTADO. No se pueden procesar más datos.');
      return { cumulativeBytes: this.cumulativeBytes, isQuotaAvailable: false };
    }

    this.cumulativeBytes += bytesTransferred;
    console.log(` [MEDIDOR] Tráfico registrado: +${bytesTransferred} bytes | Total Acumulado: ${this.cumulativeBytes} bytes`);

    // Verificar si el consumo supera la cuota pagada
    if (this.cumulativeBytes > this.paidQuotaBytes + this.config.maxUnpaidQuotaBytes) {
      console.error(` [ALERTA CORTE] Consumo (${this.cumulativeBytes} B) superó la cuota pagada (${this.paidQuotaBytes} B). Cortando tráfico...`);
      this.isConnectionActive = false;
    }

    return {
      cumulativeBytes: this.cumulativeBytes,
      isQuotaAvailable: this.isConnectionActive,
    };
  }

  /**
   * Acredita un nuevo pago exitoso aumentando la cuota de datos disponible y reactiva el tráfico
   */
  public creditPaidQuota(newPaidCumulativeBytes: number): void {
    if (newPaidCumulativeBytes >= this.cumulativeBytes) {
      this.paidQuotaBytes = newPaidCumulativeBytes;
      this.isConnectionActive = true;
      console.log(` [ACREDITACIÓN] Nuevo vale verificado. Cuota pagada actualizada a: ${this.paidQuotaBytes} bytes. Conectividad RESTAURADA.`);
    } else {
      console.warn(` [ACREDITACIÓN RECHAZADA] El vale presentado (${newPaidCumulativeBytes} B) es menor al consumo acumulado (${this.cumulativeBytes} B).`);
    }
  }

  public getStatus() {
    return {
      cumulativeBytes: this.cumulativeBytes,
      paidQuotaBytes: this.paidQuotaBytes,
      isConnectionActive: this.isConnectionActive,
    };
  }
}

// Ejemplo de prueba rápida ejecutable si se corre directamente
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('demo-meter.ts')) {
  console.log(' === Iniciando Prueba del Medidor de Tráfico (Módulo 1) ===\n');
  const meter = new NetworkDataMeter({ chunkSizeBytes: 512_000, maxUnpaidQuotaBytes: 1_000_000 });

  // 1. Simular tráfico dentro del rango de cuota
  meter.recordTraffic(500_000);
  meter.recordTraffic(400_000);

  // 2. Simular pago de vale por 1,500,000 bytes
  meter.creditPaidQuota(1_500_000);

  // 3. Simular más tráfico
  meter.recordTraffic(700_000);
  
  // 4. Intentar pasar la cuota pagada para verificar el corte automático
  meter.recordTraffic(1_000_000);
  meter.recordTraffic(500_000);

  console.log('\n Estado Final del Medidor:', meter.getStatus());
}
