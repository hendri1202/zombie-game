import { describe, expect, it } from 'vitest';
import { ZOMBIE_TYPES } from '../src/app/gameConfig';
import { ZombieStateMachine } from '../src/zombies/ZombieStateMachine';

const walker = ZOMBIE_TYPES.walker;

function sensors(distance: number, lineOfSight = true, playerAlive = true) {
  return { distanceToPlayer: distance, hasLineOfSight: lineOfSight, playerAlive };
}

/** Advances the machine enough times to leave the spawn state. */
function awake(machine: ZombieStateMachine) {
  for (let i = 0; i < 20; i += 1) machine.update(0.1, sensors(40, false));
}

describe('ZombieStateMachine', () => {
  it('starts in spawn and moves to wander without a target', () => {
    const machine = new ZombieStateMachine(walker);
    expect(machine.state).toBe('spawn');
    for (let i = 0; i < 10; i += 1) machine.update(0.1, sensors(80, false));
    expect(machine.state).toBe('wander');
  });

  it('enters chase when the player is inside sight range', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    const decision = machine.update(0.1, sensors(20, true));
    expect(decision.state).toBe('chase');
    expect(decision.shouldMoveToPlayer).toBe(true);
    expect(decision.desiredSpeed).toBe(walker.chaseSpeed);
  });

  it('attacks only when within range and gives damage exactly once', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(walker.attackRange - 0.2, true));

    let damageEvents = 0;
    let totalDamage = 0;
    // Run for the whole windup plus a margin; damage must land once.
    for (let i = 0; i < 20; i += 1) {
      const decision = machine.update(0.1, sensors(walker.attackRange - 0.2, true));
      if (decision.attackDamage > 0) {
        damageEvents += 1;
        totalDamage += decision.attackDamage;
      }
    }
    expect(damageEvents).toBe(1);
    expect(totalDamage).toBe(walker.attackDamage);
  });

  it('respects the attack cooldown between swings', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(1.2, true));
    let attacks = 0;
    // One second is shorter than the cooldown, so at most one swing can land.
    for (let i = 0; i < 10; i += 1) {
      const decision = machine.update(0.1, sensors(1.2, true));
      if (decision.attackDamage > 0) attacks += 1;
    }
    expect(attacks).toBe(1);
  });

  it('does not land damage when the player leaves range during the windup', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(1.2, true));
    let damage = 0;
    for (let i = 0; i < 12; i += 1) {
      const decision = machine.update(0.1, sensors(walker.attackRange + 8, true));
      damage += decision.attackDamage;
    }
    expect(damage).toBe(0);
  });

  it('reduces health, enters hit on a non-lethal hit and dies at zero', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(20, true));
    expect(machine.state).toBe('chase');

    const first = machine.applyDamage(20);
    expect(first.applied).toBe(20);
    expect(first.died).toBe(false);
    expect(machine.state).toBe('hit');
    expect(machine.currentHealth).toBe(walker.maxHealth - 20);

    const lethal = machine.applyDamage(walker.maxHealth);
    expect(lethal.died).toBe(true);
    expect(machine.state).toBe('death');
    expect(machine.currentHealth).toBe(0);
  });

  it('ignores damage while dead and reports when it can be removed', () => {
    const machine = new ZombieStateMachine(walker);
    machine.applyDamage(walker.maxHealth * 3);
    expect(machine.state).toBe('death');
    expect(machine.applyDamage(50).applied).toBe(0);

    let decision = machine.update(walker.deathSeconds / 2, sensors(1, true));
    expect(decision.removable).toBe(false);
    expect(decision.attackDamage).toBe(0);

    decision = machine.update(walker.deathSeconds, sensors(1, true));
    expect(decision.removable).toBe(true);
    // A dead zombie must never damage the player again.
    expect(decision.attackDamage).toBe(0);
  });

  it('stops a wind-up attack when the zombie is killed mid-swing', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(1.2, true));
    expect(machine.state).toBe('attack');
    machine.applyDamage(walker.maxHealth);
    let damage = 0;
    for (let i = 0; i < 15; i += 1) damage += machine.update(0.1, sensors(1.2, true)).attackDamage;
    expect(damage).toBe(0);
  });

  it('returns to wander when the player is out of range', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(10, true));
    const decision = machine.update(0.1, sensors(200, true));
    expect(decision.state).toBe('wander');
    expect(decision.shouldMoveToPlayer).toBe(false);
  });

  it('stops chasing a dead player', () => {
    const machine = new ZombieStateMachine(walker);
    awake(machine);
    machine.update(0.1, sensors(10, true));
    const decision = machine.update(0.1, sensors(10, true, false));
    expect(decision.state).toBe('wander');
  });

  it('scales hp and cooldown per kind', () => {
    const tank = new ZombieStateMachine(ZOMBIE_TYPES.tank);
    const runner = new ZombieStateMachine(ZOMBIE_TYPES.runner);
    expect(tank.currentHealth).toBeGreaterThan(runner.currentHealth);
    expect(ZOMBIE_TYPES.tank.attackDamage).toBeGreaterThan(ZOMBIE_TYPES.runner.attackDamage);
    expect(ZOMBIE_TYPES.runner.chaseSpeed).toBeGreaterThan(ZOMBIE_TYPES.tank.chaseSpeed);
  });
});
