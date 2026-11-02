// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Motorola MCchip

    Register reference: MVME162LX Programmer's Reference Guide, chapter 3.
    Tick timers count microseconds. Registers are held in m_regs, except
    the counters, which are computed from elapsed time while enabled.

***************************************************************************/

#include "emu.h"
#include "mcchip.h"

#include "multibyte.h"

#define VERBOSE 0
#include "logmacro.h"

DEFINE_DEVICE_TYPE(MCCHIP, mcchip_device, "mcchip", "Motorola MCchip")

mcchip_device::mcchip_device(const machine_config &mconfig, const char *tag, device_t *owner, uint32_t clock)
	: device_t(mconfig, MCCHIP, tag, owner, clock)
	, m_irq_changed(*this)
	, m_vector_written(false)
	, m_last_level(0)
{
}

void mcchip_device::device_start()
{
	m_timers[0] = { REG_T1_CONTROL, REG_T1_ICR, REG_T1_COMPARE, REG_T1_COUNTER, nullptr, 0, attotime::zero };
	m_timers[1] = { REG_T2_CONTROL, REG_T2_ICR, REG_T2_COMPARE, REG_T2_COUNTER, nullptr, 0, attotime::zero };
	m_timers[2] = { REG_T3_CONTROL, REG_T3_ICR, REG_T3_COMPARE, REG_T3_COUNTER, nullptr, 0, attotime::zero };
	m_timers[3] = { REG_T4_CONTROL, REG_T4_ICR, REG_T4_COMPARE, REG_T4_COUNTER, nullptr, 0, attotime::zero };
	for (int i = 0; i < 4; i++)
	{
		m_timers[i].timer = timer_alloc(FUNC(mcchip_device::timer_expired), this);
		save_item(NAME(m_timers[i].counter), i);
		save_item(NAME(m_timers[i].start_time), i);
	}
	save_item(NAME(m_regs));
	save_item(NAME(m_vector_written));
	save_item(NAME(m_last_level));
}

void mcchip_device::device_reset()
{
	memset(m_regs, 0, sizeof(m_regs));
	m_regs[REG_ID] = 0x84;
	m_regs[REG_REVISION] = 0x01;
	m_regs[REG_VERSION] = 0x10; // 25 MHz MC68040 on an MVME162 with VME, SCSI and Ethernet
	m_vector_written = false;
	for (tick_timer &t : m_timers)
	{
		t.counter = 0;
		t.start_time = machine().time();
		t.timer->adjust(attotime::never);
	}
	update();
}

uint32_t mcchip_device::compare(tick_timer const &t) const
{
	return get_u32be(&m_regs[t.compare_reg]);
}

uint32_t mcchip_device::current_count(tick_timer const &t) const
{
	if (!enabled(t))
		return t.counter;
	return t.counter + uint32_t((machine().time() - t.start_time).as_ticks(1'000'000));
}

void mcchip_device::set_count(tick_timer &t, uint32_t count)
{
	t.counter = count;
	t.start_time = machine().time();
	reschedule(t);
}

void mcchip_device::reschedule(tick_timer &t)
{
	if (!enabled(t))
	{
		t.timer->adjust(attotime::never);
		return;
	}
	uint32_t const remaining = compare(t) - current_count(t);
	t.timer->adjust(attotime::from_ticks(uint64_t(remaining ? remaining : 1), 1'000'000), &t - m_timers);
}

TIMER_CALLBACK_MEMBER(mcchip_device::timer_expired)
{
	tick_timer &t = m_timers[param];

	uint8_t &control = m_regs[t.control_reg];
	control = (control & 0x0f) | ((control + 0x10) & 0xf0); // overflow count

	t.counter = (control & CONTROL_COC) ? 0 : compare(t);
	t.start_time = machine().time();

	if (m_regs[t.icr_reg] & ICR_IEN)
		m_regs[t.icr_reg] |= ICR_INT;

	reschedule(t);
	update();
}

uint8_t mcchip_device::read(offs_t offset)
{
	offset %= sizeof(m_regs);

	for (tick_timer const &t : m_timers)
	{
		if (offset >= t.counter_reg && offset < t.counter_reg + 4)
			return BIT(current_count(t), (3 - (offset - t.counter_reg)) * 8, 8);
	}
	if (offset == REG_VECTOR)
		return m_vector_written ? (m_regs[offset] & 0xf0) : 0x0f;
	return m_regs[offset];
}

void mcchip_device::write(offs_t offset, uint8_t data)
{
	offset %= sizeof(m_regs);
	LOG("%s: write %02x = %02x\n", machine().describe_context(), offset, data);

	for (tick_timer &t : m_timers)
	{
		if (offset >= t.counter_reg && offset < t.counter_reg + 4)
		{
			unsigned const shift = (3 - (offset - t.counter_reg)) * 8;
			set_count(t, (current_count(t) & ~(uint32_t(0xff) << shift)) | (uint32_t(data) << shift));
			return;
		}
		if (offset >= t.compare_reg && offset < t.compare_reg + 4)
		{
			m_regs[offset] = data;
			reschedule(t);
			return;
		}
		if (offset == t.control_reg)
		{
			uint32_t const count = current_count(t);
			uint8_t &control = m_regs[offset];
			control = (control & 0xf0) | (data & (CONTROL_CEN | CONTROL_COC));
			if (data & CONTROL_COVF)
				control &= 0x0f;
			set_count(t, count);
			return;
		}
	}

	switch (offset)
	{
	case REG_ID:
	case REG_REVISION:
	case REG_GPI:
	case REG_VERSION:
		break;

	case REG_VECTOR:
		m_regs[offset] = data & 0xf0;
		m_vector_written = true;
		break;

	case REG_T1_ICR:
	case REG_T2_ICR:
	case REG_T3_ICR:
	case REG_T4_ICR:
	case REG_LAN_ICR:
	case REG_LAN_ERR_ICR:
	case REG_ABORT_ICR:
		m_regs[offset] = (m_regs[offset] & ICR_INT) | (data & ~(ICR_INT | ICR_ICLR));
		if (data & ICR_ICLR)
			m_regs[offset] &= ~ICR_INT;
		break;

	case REG_SCC_ICR:
	case REG_SCSI_ICR:
		// INT follows the chip's pin
		m_regs[offset] = (m_regs[offset] & ICR_INT) | (data & (ICR_IEN | ICR_LEVEL));
		break;

	default:
		m_regs[offset] = data;
		break;
	}
	update();
}

void mcchip_device::set_pin(unsigned reg, int state)
{
	if (state)
		m_regs[reg] |= ICR_INT;
	else
		m_regs[reg] &= ~ICR_INT;
	update();
}

// Highest priority first, as in the daisy chain
static constexpr struct { uint8_t reg; int8_t vector; } SOURCES[] = {
	{ 0x43, 0xe }, { 0x1d, mcchip_device::ACK_SCC }, { 0x1c, 0xb }, { 0x1b, 0x9 }, { 0x1a, 0x8 },
	{ 0x2a, 0x7 }, { 0x2b, 0x6 }, { 0x2f, 0x5 }, { 0x19, 0x4 }, { 0x18, 0x3 }
};

int mcchip_device::level() const
{
	if (!(m_regs[REG_GENERAL] & GENERAL_MIEN))
		return 0;

	int highest = 0;
	for (auto const &source : SOURCES)
	{
		uint8_t const icr = m_regs[source.reg];
		if ((icr & ICR_INT) && (icr & ICR_IEN))
			highest = std::max<int>(highest, icr & ICR_LEVEL);
	}
	return highest;
}

int mcchip_device::acknowledge(int level)
{
	if (m_regs[REG_GENERAL] & GENERAL_MIEN)
	{
		for (auto const &source : SOURCES)
		{
			uint8_t const icr = m_regs[source.reg];
			if ((icr & ICR_INT) && (icr & ICR_IEN) && (icr & ICR_LEVEL) == level)
				return source.vector == ACK_SCC ? ACK_SCC : (m_regs[REG_VECTOR] & 0xf0) | source.vector;
		}
	}
	return ACK_NONE;
}

void mcchip_device::update()
{
	int const current = level();
	if (current != m_last_level)
	{
		m_last_level = current;
		m_irq_changed(1);
		m_irq_changed(0);
	}
}
