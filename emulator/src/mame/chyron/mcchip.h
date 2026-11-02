// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Motorola MCchip: peripheral glue on the MVME162. Four tick timers, and
    interrupt control for the SCC, SCSI and LAN chips.

***************************************************************************/

#ifndef MAME_CHYRON_MCCHIP_H
#define MAME_CHYRON_MCCHIP_H

#pragma once

class mcchip_device : public device_t
{
public:
	static constexpr int ACK_SCC = -2; // the SCC supplies the vector
	static constexpr int ACK_NONE = -1;

	mcchip_device(const machine_config &mconfig, const char *tag, device_t *owner, uint32_t clock);

	auto irq_changed() { return m_irq_changed.bind(); }

	uint8_t read(offs_t offset);
	void write(offs_t offset, uint8_t data);

	void scc_irq_w(int state) { set_pin(REG_SCC_ICR, state); }
	void scsi_irq_w(int state) { set_pin(REG_SCSI_ICR, state); }
	void lan_irq_w(int state) { set_pin(REG_LAN_ICR, state); }

	// Highest active interrupt level, 0 for none
	int level() const;

	// Vector for an acknowledge at this level, or ACK_SCC or ACK_NONE
	int acknowledge(int level);

protected:
	virtual void device_start() override ATTR_COLD;
	virtual void device_reset() override ATTR_COLD;

private:
	enum
	{
		REG_ID = 0x00,
		REG_REVISION = 0x01,
		REG_GENERAL = 0x02,
		REG_VECTOR = 0x03,
		REG_T1_COMPARE = 0x04,
		REG_T1_COUNTER = 0x08,
		REG_T2_COMPARE = 0x0c,
		REG_T2_COUNTER = 0x10,
		REG_T2_CONTROL = 0x16,
		REG_T1_CONTROL = 0x17,
		REG_T4_ICR = 0x18,
		REG_T3_ICR = 0x19,
		REG_T2_ICR = 0x1a,
		REG_T1_ICR = 0x1b,
		REG_PARITY_ICR = 0x1c,
		REG_SCC_ICR = 0x1d,
		REG_T4_CONTROL = 0x1e,
		REG_T3_CONTROL = 0x1f,
		REG_LAN_ICR = 0x2a,
		REG_LAN_ERR_ICR = 0x2b,
		REG_GPI = 0x2d,
		REG_VERSION = 0x2e,
		REG_SCSI_ICR = 0x2f,
		REG_T3_COMPARE = 0x30,
		REG_T3_COUNTER = 0x34,
		REG_T4_COMPARE = 0x38,
		REG_T4_COUNTER = 0x3c,
		REG_ABORT_ICR = 0x43
	};

	static constexpr uint8_t GENERAL_MIEN = 0x02;

	static constexpr uint8_t ICR_INT = 0x20;
	static constexpr uint8_t ICR_IEN = 0x10;
	static constexpr uint8_t ICR_ICLR = 0x08;
	static constexpr uint8_t ICR_LEVEL = 0x07;

	static constexpr uint8_t CONTROL_CEN = 0x01;
	static constexpr uint8_t CONTROL_COC = 0x02;
	static constexpr uint8_t CONTROL_COVF = 0x04;

	struct tick_timer
	{
		unsigned control_reg;
		unsigned icr_reg;
		unsigned compare_reg;
		unsigned counter_reg;
		emu_timer *timer;
		uint32_t counter;  // value at start_time
		attotime start_time;
	};

	TIMER_CALLBACK_MEMBER(timer_expired);

	bool enabled(tick_timer const &t) const { return m_regs[t.control_reg] & CONTROL_CEN; }
	uint32_t current_count(tick_timer const &t) const;
	uint32_t compare(tick_timer const &t) const;
	void set_count(tick_timer &t, uint32_t count);
	void reschedule(tick_timer &t);
	void set_pin(unsigned reg, int state);
	void update();

	devcb_write_line m_irq_changed;

	uint8_t m_regs[0x50];
	tick_timer m_timers[4];
	bool m_vector_written;
	int m_last_level;
};

DECLARE_DEVICE_TYPE(MCCHIP, mcchip_device)

#endif // MAME_CHYRON_MCCHIP_H
