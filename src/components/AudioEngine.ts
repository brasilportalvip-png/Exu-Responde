/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

class AudioEngineClass {
  private ctx: AudioContext | null = null;
  private droneOsc: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;

  private initCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playDrone() {
    try {
      this.initCtx();
      if (!this.ctx) return;
      if (this.droneOsc) return; // already running

      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      // Atmospheric sub-bass drone (Abyss spirit)
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(55, ctx.currentTime); // A1 note
      
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(110, ctx.currentTime); // A2 note

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(180, ctx.currentTime);

      // Modulate lowpass frequency for undulating mistic smoke feeling
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.setValueAtTime(0.2, ctx.currentTime); // very slow sweep
      lfoGain.gain.setValueAtTime(60, ctx.currentTime);
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();

      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 3); // fade in

      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc2.start();

      this.droneOsc = osc;
      this.droneGain = gain;
      this.filter = filter;
    } catch (e) {
      console.warn("Web Audio drone blocked:", e);
    }
  }

  stopDrone() {
    if (this.droneGain && this.ctx) {
      try {
        const ctx = this.ctx;
        this.droneGain.gain.cancelScheduledValues(ctx.currentTime);
        this.droneGain.gain.setValueAtTime(this.droneGain.gain.value, ctx.currentTime);
        this.droneGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
        
        const osc = this.droneOsc;
        setTimeout(() => {
          try {
            osc?.stop();
          } catch (e) {}
        }, 1600);
      } catch (e) {}
    }
    this.droneOsc = null;
    this.droneGain = null;
  }

  playCrystalBell() {
    try {
      this.initCtx();
      if (!this.ctx) return;
      const ctx = this.ctx;
      
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const oscSub = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = "sine";
      // Pure crystalline golden frequency (528Hz - Solfeggio Love frequency)
      osc.frequency.setValueAtTime(528, now);
      
      oscSub.type = "triangle";
      oscSub.frequency.setValueAtTime(264, now); // Octave lower for body

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);

      osc.connect(gain);
      oscSub.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      oscSub.start(now);
      
      osc.stop(now + 3);
      oscSub.stop(now + 3);
    } catch (e) {}
  }

  playPortalSwoosh() {
    try {
      this.initCtx();
      if (!this.ctx) return;
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // Generate pink noise dynamically inside the browser
      const bufferSize = ctx.sampleRate * 1.5;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let b0, b1, b2, b3, b4, b5, b6;
      b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;
      
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        data[i] *= 0.11; // scale down
        b6 = white * 0.115926;
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      // Dynamic frequency sweep simulating hot magical portal opening
      filter.frequency.setValueAtTime(200, now);
      filter.frequency.exponentialRampToValueAtTime(1600, now + 0.8);
      filter.frequency.exponentialRampToValueAtTime(250, now + 1.4);
      filter.Q.setValueAtTime(3.0, now);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);

      noiseSource.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      noiseSource.start(now);
      noiseSource.stop(now + 1.5);
    } catch (e) {}
  }

  playThunderStrike() {
    try {
      this.initCtx();
      if (!this.ctx) return;
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // Rumble generator
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(45, now);
      osc.frequency.linearRampToValueAtTime(10, now + 1.8);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(80, now);

      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 2.0);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 2.2);

      // Metallic electric lightning spike sound
      const spike = ctx.createOscillator();
      const spikeGain = ctx.createGain();
      spike.type = "triangle";
      spike.frequency.setValueAtTime(800, now);
      spike.frequency.exponentialRampToValueAtTime(80, now + 0.25);

      spikeGain.gain.setValueAtTime(0.3, now);
      spikeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      spike.connect(spikeGain);
      spikeGain.connect(ctx.destination);
      spike.start(now);
      spike.stop(now + 0.4);
    } catch (e) {}
  }
}

export const AudioEngine = new AudioEngineClass();
