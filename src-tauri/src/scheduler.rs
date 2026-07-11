use std::time::{Duration, Instant};

const RESPONSIVE_WAIT_SLICE: Duration = Duration::from_millis(20);

pub struct HighResolutionWaiter {
    #[cfg(target_os = "windows")]
    handle: *mut std::ffi::c_void,
}

impl HighResolutionWaiter {
    pub fn new() -> Self {
        #[cfg(target_os = "windows")]
        {
            let handle = unsafe {
                create_waitable_timer_ex_w(
                    std::ptr::null(),
                    std::ptr::null(),
                    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                    TIMER_ALL_ACCESS,
                )
            };
            let handle = if handle.is_null() {
                unsafe {
                    create_waitable_timer_ex_w(
                        std::ptr::null(),
                        std::ptr::null(),
                        0,
                        TIMER_ALL_ACCESS,
                    )
                }
            } else {
                handle
            };
            Self { handle }
        }

        #[cfg(not(target_os = "windows"))]
        Self {}
    }

    pub fn sleep_for(&self, duration: Duration) {
        if duration.is_zero() {
            return;
        }

        #[cfg(target_os = "windows")]
        if !self.handle.is_null() {
            let hundred_nanoseconds = (duration.as_nanos() / 100).max(1);
            let due_time = -(hundred_nanoseconds.min(i64::MAX as u128) as i64);
            let set = unsafe {
                set_waitable_timer(
                    self.handle,
                    &due_time,
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                    0,
                )
            };
            if set != 0 {
                unsafe {
                    wait_for_single_object(self.handle, INFINITE);
                }
                return;
            }
        }

        std::thread::sleep(duration);
    }

    pub fn wait_until<F>(&self, deadline: Instant, mut should_continue: F) -> bool
    where
        F: FnMut() -> bool,
    {
        loop {
            if !should_continue() {
                return false;
            }

            let now = Instant::now();
            if now >= deadline {
                return true;
            }

            self.sleep_for((deadline - now).min(RESPONSIVE_WAIT_SLICE));
        }
    }
}

impl Default for HighResolutionWaiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "windows")]
impl Drop for HighResolutionWaiter {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                close_handle(self.handle);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct TimelineAnchor {
    real_anchor: Instant,
    song_anchor_us: u64,
    speed: f64,
}

impl TimelineAnchor {
    pub fn new(real_anchor: Instant, song_anchor_us: u64, speed: f64) -> Self {
        Self {
            real_anchor,
            song_anchor_us,
            speed: speed.max(0.01),
        }
    }

    pub fn song_position_us(&self, now: Instant) -> u64 {
        if now <= self.real_anchor {
            return self.song_anchor_us;
        }
        self.song_anchor_us.saturating_add(
            (now.duration_since(self.real_anchor).as_micros() as f64 * self.speed) as u64,
        )
    }

    pub fn deadline_for(&self, song_time_us: u64) -> Instant {
        let delta_song_us = song_time_us.saturating_sub(self.song_anchor_us);
        self.real_anchor + Duration::from_micros((delta_song_us as f64 / self.speed) as u64)
    }

    pub fn reanchor(&mut self, now: Instant, speed: f64) {
        self.song_anchor_us = self.song_position_us(now);
        self.real_anchor = now;
        self.speed = speed.max(0.01);
    }

    pub fn shift_real_anchor(&mut self, pause_duration: Duration) {
        self.real_anchor += pause_duration;
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }
}

#[cfg(target_os = "windows")]
const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION: u32 = 0x0000_0002;
#[cfg(target_os = "windows")]
const TIMER_ALL_ACCESS: u32 = 0x001F_0003;
#[cfg(target_os = "windows")]
const INFINITE: u32 = 0xFFFF_FFFF;

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    #[link_name = "CreateWaitableTimerExW"]
    fn create_waitable_timer_ex_w(
        timer_attributes: *const std::ffi::c_void,
        timer_name: *const u16,
        flags: u32,
        desired_access: u32,
    ) -> *mut std::ffi::c_void;
    #[link_name = "SetWaitableTimer"]
    fn set_waitable_timer(
        timer: *mut std::ffi::c_void,
        due_time: *const i64,
        period_ms: i32,
        completion_routine: *const std::ffi::c_void,
        completion_arg: *const std::ffi::c_void,
        resume: i32,
    ) -> i32;
    #[link_name = "WaitForSingleObject"]
    fn wait_for_single_object(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    #[link_name = "CloseHandle"]
    fn close_handle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_absolute_deadlines_without_millisecond_rounding() {
        let start = Instant::now();
        let anchor = TimelineAnchor::new(start, 250_000, 1.0);
        assert_eq!(
            anchor.deadline_for(250_321).duration_since(start),
            Duration::from_micros(321)
        );
    }

    #[test]
    fn speed_reanchor_preserves_current_song_position() {
        let start = Instant::now();
        let now = start + Duration::from_millis(500);
        let mut anchor = TimelineAnchor::new(start, 0, 1.0);
        assert_eq!(anchor.song_position_us(now), 500_000);
        anchor.reanchor(now, 2.0);
        assert_eq!(anchor.song_position_us(now), 500_000);
        assert_eq!(
            anchor.song_position_us(now + Duration::from_millis(100)),
            700_000
        );
    }

    #[test]
    fn pausing_moves_deadlines_without_advancing_song_time() {
        let start = Instant::now();
        let mut anchor = TimelineAnchor::new(start, 0, 1.0);
        let before = anchor.deadline_for(1_000_000);
        anchor.shift_real_anchor(Duration::from_millis(250));
        assert_eq!(
            anchor.deadline_for(1_000_000).duration_since(before),
            Duration::from_millis(250)
        );
    }
}
