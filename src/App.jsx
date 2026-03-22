import {
	BarChart3,
	Info,
	MoonStar,
	PoundSterling,
	Timer,
	TrendingDown,
	Upload,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const OVERNIGHT_START_MINUTES = 1410;
const OVERNIGHT_END_MINUTES = 330;
const OVERNIGHT_SLOT_COUNT =
	((24 * 60 - OVERNIGHT_START_MINUTES) + OVERNIGHT_END_MINUTES) / 30;
const OFF_PEAK_EV_THRESHOLD_KWH = 18;
const PEAK_START_MINUTES = 330;
const PEAK_END_MINUTES = 1410;
const PEAK_SLOT_COUNT = (PEAK_END_MINUTES - PEAK_START_MINUTES) / 30;

const percentile = (sortedValues, fraction) => {
	if (!sortedValues.length) return 0;

	const index = (sortedValues.length - 1) * fraction;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);

	if (lower === upper) return sortedValues[lower];

	const weight = index - lower;
	return (
		sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight
	);
};

const calculateMode = (values) => {
	if (!values.length) return 0;

	const frequency = new Map();
	let bestValue = values[0];
	let bestCount = 0;

	values.forEach((value) => {
		const roundedValue = Math.round(value);
		const count = (frequency.get(roundedValue) ?? 0) + 1;
		frequency.set(roundedValue, count);

		if (count > bestCount || (count === bestCount && roundedValue < bestValue)) {
			bestValue = roundedValue;
			bestCount = count;
		}
	});

	return bestValue;
};

const shiftDateString = (dateStr, dayOffset) => {
	const date = new Date(`${dateStr}T00:00:00`);
	date.setDate(date.getDate() + dayOffset);
	return date.toISOString().slice(0, 10);
};

const calculateDemandSummary = (
	periods,
	{ usageKey, countKey, expectedSlots, maxUsage = null },
) => {
	const completePeriods = periods.filter(
		(period) => period[countKey] === expectedSlots,
	);

	if (!completePeriods.length) {
		return {
			averageWattsPerHour: 0,
			averageUsage: 0,
			medianWattsPerHour: 0,
			modeWattsPerHour: 0,
			lowestWattsPerHour: 0,
			highestWattsPerHour: 0,
			sampledDays: 0,
			excludedDays: 0,
			totalEligibleDays: 0,
		};
	}

	let sampledPeriods = completePeriods;
	let excludedPeriods = 0;

	if (maxUsage !== null) {
		const filteredPeriods = completePeriods.filter(
			(period) => period[usageKey] <= maxUsage,
		);
		sampledPeriods = filteredPeriods.length ? filteredPeriods : completePeriods;
		excludedPeriods = completePeriods.length - sampledPeriods.length;
	}

	const totalUsage = sampledPeriods.reduce((sum, period) => sum + period[usageKey], 0);
	const averageUsage = totalUsage / sampledPeriods.length;
	const averageWattsPerHour = (averageUsage / expectedSlots) * 2000;
	const periodAverageWattsPerHour = sampledPeriods
		.map((period) => (period[usageKey] / expectedSlots) * 2000)
		.sort((a, b) => a - b);

	return {
		averageWattsPerHour,
		averageUsage,
		medianWattsPerHour: percentile(periodAverageWattsPerHour, 0.5),
		modeWattsPerHour: calculateMode(periodAverageWattsPerHour),
		lowestWattsPerHour: periodAverageWattsPerHour[0],
		highestWattsPerHour:
			periodAverageWattsPerHour[periodAverageWattsPerHour.length - 1],
		sampledDays: sampledPeriods.length,
		excludedDays: excludedPeriods,
		totalEligibleDays: completePeriods.length,
	};
};

export default function App() {
	const [parsedData, setParsedData] = useState(null);
	const [customCapacity, setCustomCapacity] = useState("");
	const [peakRate, setPeakRate] = useState("0.2914");
	const [offPeakRate, setOffPeakRate] = useState("0.07");
	const [equipmentCost, setEquipmentCost] = useState("4500");
	const [result, setResult] = useState(null);
	const [error, setError] = useState(null);
	const [isProcessing, setIsProcessing] = useState(false);
	const [historyView, setHistoryView] = useState("total"); // 'total', 'peak', 'offPeak'
	const [profileView, setProfileView] = useState("all"); // 'all', 'weekday', 'weekend'
	const fileInputRef = useRef(null);

	// Safe currency formatter
	const formatCurrency = (val) => {
		const num = parseFloat(val);
		if (isNaN(num)) return "£0.00";
		return `£${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	};

	// Improved percentage calculation with precision
	const calculatePercentage = (savings, current) => {
		const s = parseFloat(savings);
		const c = parseFloat(current);
		if (!c || isNaN(s) || isNaN(c) || c === 0) return "0";
		const percent = (s / c) * 100;
		return isNaN(percent) ? "0" : percent.toFixed(1);
	};

	const parseCSVData = (text) => {
		const lines = text.split("\n");
		let daily = {};
		let overnightWindows = {};

		let profiles = {
			all: { hourly: new Array(48).fill(0), counts: new Array(48).fill(0) },
			weekday: { hourly: new Array(48).fill(0), counts: new Array(48).fill(0) },
			weekend: { hourly: new Array(48).fill(0), counts: new Array(48).fill(0) },
		};

		let validRows = 0;

		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;

			const cols = line.split(",");
			if (cols.length < 2) continue;

			const val = parseFloat(cols[0]);
			if (isNaN(val)) continue;

			const timeStr = cols[1]?.trim();
			if (!timeStr) continue;

			const datePart = timeStr.split("T")[0];
			const timePart =
				timeStr.split("T")[1]?.split("+")[0] ||
				timeStr.split("T")[1]?.split("Z")[0];

			if (!datePart || !timePart) continue;

			validRows++;

			const [hourStr, minStr] = timePart.split(":");
			const hour = parseInt(hourStr, 10);
			const min = parseInt(minStr, 10);
			const timeInMins = hour * 60 + min;

			const dateObj = new Date(datePart);
			if (isNaN(dateObj.getTime())) continue;

			const dayOfWeek = dateObj.getDay();
			const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

			if (!daily[datePart]) {
				daily[datePart] = {
					peak: 0,
					peakCount: 0,
					offPeak: 0,
					isWeekend,
					date: datePart,
				};
			}

				const isPeak =
					timeInMins >= PEAK_START_MINUTES && timeInMins < PEAK_END_MINUTES;
				const isOvernightWindow =
					timeInMins >= OVERNIGHT_START_MINUTES ||
					timeInMins < OVERNIGHT_END_MINUTES;

				if (isPeak) {
					daily[datePart].peak += val;
					daily[datePart].peakCount++;
				} else {
					daily[datePart].offPeak += val;
				}

			if (isOvernightWindow) {
				const overnightKey =
					timeInMins >= OVERNIGHT_START_MINUTES
						? datePart
						: shiftDateString(datePart, -1);

				if (!overnightWindows[overnightKey]) {
					overnightWindows[overnightKey] = {
						date: overnightKey,
						overnight: 0,
						overnightCount: 0,
					};
				}

				overnightWindows[overnightKey].overnight += val;
				overnightWindows[overnightKey].overnightCount++;
			}

			const slotIndex = hour * 2 + (min >= 30 ? 1 : 0);
			if (slotIndex >= 0 && slotIndex < 48) {
				profiles.all.hourly[slotIndex] += val;
				profiles.all.counts[slotIndex]++;

				if (isWeekend) {
					profiles.weekend.hourly[slotIndex] += val;
					profiles.weekend.counts[slotIndex]++;
				} else {
					profiles.weekday.hourly[slotIndex] += val;
					profiles.weekday.counts[slotIndex]++;
				}
			}
		}

		if (validRows === 0)
			throw new Error("No valid electricity consumption data found.");

		const dailyArray = Object.values(daily).sort(
			(a, b) => new Date(a.date) - new Date(b.date),
		);
		const overnightArray = Object.values(overnightWindows).sort(
			(a, b) => new Date(a.date) - new Date(b.date),
		);
		return { dailyArray, overnightArray, profiles };
	};

	useEffect(() => {
		if (!parsedData || !parsedData.dailyArray.length) return;

		const pRate = parseFloat(peakRate) || 0;
		const opRate = parseFloat(offPeakRate) || 0;
		const eCost = parseFloat(equipmentCost) || 0;

		let totalPeakUsage = 0;
		let totalOffPeakUsage = 0;
		let wdPeakTotal = 0,
			wdOffPeakTotal = 0,
			wdCount = 0;
		let wePeakTotal = 0,
			weOffPeakTotal = 0,
			weCount = 0;

		parsedData.dailyArray.forEach((day) => {
			totalPeakUsage += day.peak;
			totalOffPeakUsage += day.offPeak;
			if (day.isWeekend) {
				wePeakTotal += day.peak;
				weOffPeakTotal += day.offPeak;
				weCount++;
			} else {
				wdPeakTotal += day.peak;
				wdOffPeakTotal += day.offPeak;
				wdCount++;
			}
		});

		const totalDays = parsedData.dailyArray.length || 1;
		const avgOverallPeak = totalPeakUsage / totalDays;
		const idealCapacity = avgOverallPeak * 1.15;
		const overnightDemand = calculateDemandSummary(parsedData.overnightArray ?? [], {
			usageKey: "overnight",
			countKey: "overnightCount",
			expectedSlots: OVERNIGHT_SLOT_COUNT,
			maxUsage: OFF_PEAK_EV_THRESHOLD_KWH,
		});
		const peakDemand = calculateDemandSummary(parsedData.dailyArray, {
			usageKey: "peak",
			countKey: "peakCount",
			expectedSlots: PEAK_SLOT_COUNT,
		});
		const userCap = parseFloat(customCapacity);
		const activeCapacity =
			!isNaN(userCap) && userCap >= 0 ? userCap : idealCapacity;

		let totalCurrentCost = 0;
		let totalNewCost = 0;

		parsedData.dailyArray.forEach((day) => {
			const currentCost = day.peak * pRate + day.offPeak * opRate;

			// Simulation: Shift peak load to off-peak via battery (90% round-trip efficiency)
			const shiftable = Math.min(day.peak, activeCapacity);
			const remainingPeak = day.peak - shiftable;
			const rechargeCost = (shiftable / 0.9) * opRate;

			const newCost =
				rechargeCost + remainingPeak * pRate + day.offPeak * opRate;

			totalCurrentCost += currentCost;
			totalNewCost += newCost;
		});

		const finalizeProfile = (p) => {
			return p.hourly.map((val, idx) =>
				p.counts[idx] > 0 ? val / p.counts[idx] : 0,
			);
		};

		const dailySaving = (totalCurrentCost - totalNewCost) / totalDays;

		setResult({
			avgWdPeak: wdCount ? wdPeakTotal / wdCount : 0,
			avgWdOffPeak: wdCount ? wdOffPeakTotal / wdCount : 0,
			avgWePeak: weCount ? wePeakTotal / weCount : 0,
			avgWeOffPeak: weCount ? weOffPeakTotal / weCount : 0,
			avgOverallPeak,
			idealCapacity,
			activeCapacity,
			overnightDemand,
			peakDemand,
			profiles: {
				all: finalizeProfile(parsedData.profiles.all),
				weekday: finalizeProfile(parsedData.profiles.weekday),
				weekend: finalizeProfile(parsedData.profiles.weekend),
			},
			dailyArray: parsedData.dailyArray,
			currentWeeklyCost: (totalCurrentCost / totalDays) * 7,
			newWeeklyCost: (totalNewCost / totalDays) * 7,
			currentAnnualCost: (totalCurrentCost / totalDays) * 365,
			newAnnualCost: (totalNewCost / totalDays) * 365,
			annualSavings: dailySaving * 365,
			weeklySavings: dailySaving * 7,
			paybackPeriod: dailySaving * 365 > 1 ? eCost / (dailySaving * 365) : null,
			daysAnalyzed: totalDays,
		});
	}, [parsedData, customCapacity, peakRate, offPeakRate, equipmentCost]);

	const timelineMax = useMemo(() => {
		if (!result?.dailyArray) return 1;
		const maxVal = result.dailyArray.reduce((max, day) => {
			const val =
				historyView === "total"
					? day.peak + day.offPeak
					: historyView === "peak"
						? day.peak
						: day.offPeak;
			return Math.max(max, val);
		}, 0);
		return maxVal <= 0 ? 1 : maxVal * 1.1;
	}, [result, historyView]);

	const profileMax = useMemo(() => {
		if (!result?.profiles) return 1;
		const maxVal = Math.max(...result.profiles[profileView]);
		return maxVal <= 0 ? 1 : maxVal * 1.1;
	}, [result, profileView]);

	const formatDemand = (value) => {
		if (value >= 1000) return `${(value / 1000).toFixed(2)} kW/h`;
		return `${Math.round(value).toLocaleString()} W/h`;
	};

	return (
		<div className="min-h-screen bg-slate-50 p-6 font-sans text-slate-800 antialiased">
			<div className="max-w-6xl mx-auto space-y-6">
				{/* Header Container */}
				<header className="bg-white rounded-2xl p-8 shadow-sm border border-slate-100 flex flex-col md:flex-row items-center justify-between gap-6">
					<div className="flex flex-col items-center md:items-start text-center md:text-left">
						<div className="flex items-center gap-2 mb-1">
							<Zap className="text-amber-500 w-6 h-6 shrink-0" />
							<h1 className="text-xl font-bold text-slate-900 m-0 p-0 leading-none">
								Battery Storage Analyser
							</h1>
						</div>
						<p className="text-slate-500 text-sm font-normal m-0 p-0">
							Adjust rates and capacity to see your real-world savings
							potential.
						</p>
					</div>

					<div className="shrink-0">
						<input
							type="file"
							accept=".csv"
							className="hidden"
							ref={fileInputRef}
							onChange={(e) => {
								const file = e.target.files[0];
								if (!file) return;
								setIsProcessing(true);
								const reader = new FileReader();
								reader.onload = (evt) => {
									try {
										setParsedData(parseCSVData(evt.target.result));
									} catch (err) {
										setError(err.message);
									} finally {
										setIsProcessing(false);
									}
								};
								reader.readAsText(file);
							}}
						/>
						<button
							onClick={() => fileInputRef.current?.click()}
							disabled={isProcessing}
							className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-medium text-sm transition-all shadow-sm active:scale-95 text-center"
						>
							<Upload size={18} />
							{isProcessing
								? "Processing..."
								: parsedData
									? "Upload New File"
									: (
										<span className="leading-tight">
											<span className="block">Upload consumption.csv</span>
											<span className="block text-[11px] text-blue-100">
												(Octopus Export)
											</span>
										</span>
									)}
						</button>
					</div>
				</header>

				{error && (
					<div className="bg-red-50 text-red-700 p-4 rounded-xl border border-red-100 flex items-start gap-3">
						<Info className="shrink-0 mt-0.5" size={20} />
						<p>{error}</p>
					</div>
				)}

				{result && (
					<div className="space-y-6 animate-in fade-in duration-500">
						{/* Rates & Hardware Controls */}
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
							<div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
								<label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
									Peak Rate (£/kWh)
								</label>
								<div className="relative">
									<span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
										£
									</span>
									<input
										type="number"
										step="0.0001"
										value={peakRate}
										onChange={(e) => setPeakRate(e.target.value)}
										className="w-full pl-7 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold focus:outline-none focus:ring-1 focus:ring-blue-500"
									/>
								</div>
							</div>
							<div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
								<label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
									Off-Peak Rate (£/kWh)
								</label>
								<div className="relative">
									<span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
										£
									</span>
									<input
										type="number"
										step="0.0001"
										value={offPeakRate}
										onChange={(e) => setOffPeakRate(e.target.value)}
										className="w-full pl-7 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold focus:outline-none focus:ring-1 focus:ring-blue-500"
									/>
								</div>
							</div>
							<div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
								<label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
									Battery Size (kWh)
								</label>
								<div className="flex items-center gap-2">
									<input
										type="number"
										step="0.5"
										value={customCapacity}
										placeholder={result.idealCapacity.toFixed(1)}
										onChange={(e) => setCustomCapacity(e.target.value)}
										className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold focus:outline-none focus:ring-1 focus:ring-blue-500"
									/>
									<span className="text-xs font-bold text-slate-400">kWh</span>
								</div>
							</div>
							<div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
								<label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
									Hardware Cost (£)
								</label>
								<div className="relative">
									<span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
										£
									</span>
									<input
										type="number"
										step="50"
										value={equipmentCost}
										onChange={(e) => setEquipmentCost(e.target.value)}
										className="w-full pl-7 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-bold focus:outline-none focus:ring-1 focus:ring-blue-500"
									/>
								</div>
							</div>
						</div>

						{/* ROI Overview */}
						<div className="bg-gradient-to-br from-blue-900 to-slate-900 rounded-2xl p-8 shadow-lg text-white">
							<div className="flex flex-col lg:flex-row gap-8 items-center">
								<div className="flex-1 text-center lg:text-left">
									<h2 className="text-lg font-medium text-blue-200">
										Investment Snapshot
									</h2>
									<div className="grid grid-cols-1 sm:grid-cols-2 gap-8 mt-6">
										<div>
											<div className="text-sm font-medium text-blue-300">
												Annual Saving
											</div>
											<div className="text-4xl font-black mt-1 text-emerald-400">
												{formatCurrency(result.annualSavings)}
											</div>
										</div>
										<div>
											<div className="text-sm font-medium text-blue-300">
												Payback Period
											</div>
											<div className="text-4xl font-black mt-1">
												{result.paybackPeriod
													? result.paybackPeriod.toFixed(1)
													: "∞"}{" "}
												<span className="text-xl font-medium text-blue-300">
													Years
												</span>
											</div>
										</div>
									</div>
								</div>
								<div className="lg:w-72 bg-white/10 backdrop-blur-md rounded-2xl p-6 border border-white/10 text-center">
									<div className="inline-flex p-3 bg-blue-500/20 rounded-full mb-3">
										<Timer className="text-blue-300" size={32} />
									</div>
									<div className="text-xs font-bold text-blue-300 uppercase tracking-wider">
										Break-Even Point
									</div>
									<div className="text-sm mt-2 text-slate-200 leading-tight">
										Investment recovered in{" "}
										<strong>
											{result.paybackPeriod
												? result.paybackPeriod.toFixed(0)
												: "many"}{" "}
											years
										</strong>{" "}
										via bill reduction.
									</div>
								</div>
							</div>
						</div>

							<div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
								<div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
									<div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
										<div>
											<div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
												23:30-05:30 Off-Peak Demand
											</div>
											<div className="mt-3 flex items-end gap-3">
												<div className="text-4xl font-black text-slate-900">
													{result.overnightDemand.totalEligibleDays
														? formatDemand(
																result.overnightDemand.averageWattsPerHour,
															).replace(/ (W\/h|kW\/h)$/, "")
														: "—"}
												</div>
												{result.overnightDemand.totalEligibleDays ? (
													<div className="pb-1 text-sm font-bold uppercase tracking-wide text-slate-400">
														{result.overnightDemand.averageWattsPerHour >= 1000
															? "kW/h average demand"
															: "W/h average demand"}
													</div>
												) : null}
											</div>
											<p className="mt-2 max-w-2xl text-sm text-slate-500">
												Estimated from the quiet overnight window and filtered to
												ignore unusually high nights that are likely EV charging.
											</p>
										</div>
										<div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
											<MoonStar size={28} />
										</div>
									</div>
									<div className="mt-6 grid grid-cols-1 gap-4 border-t border-slate-100 pt-6 sm:grid-cols-3">
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Avg Off-Peak Usage
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.overnightDemand.totalEligibleDays
													? `${result.overnightDemand.averageUsage.toFixed(2)} kWh`
													: "Not enough data"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Mode
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.overnightDemand.totalEligibleDays
													? formatDemand(result.overnightDemand.modeWattsPerHour)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Median
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.overnightDemand.totalEligibleDays
													? formatDemand(result.overnightDemand.medianWattsPerHour)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Lowest
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.overnightDemand.totalEligibleDays
													? formatDemand(result.overnightDemand.lowestWattsPerHour)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Highest
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.overnightDemand.totalEligibleDays
													? formatDemand(result.overnightDemand.highestWattsPerHour)
													: "—"}
											</div>
										</div>
									</div>
								</div>

								<div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
									<div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
										<div>
											<div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
												05:30-23:30 Peak Demand
											</div>
											<div className="mt-3 flex items-end gap-3">
												<div className="text-4xl font-black text-slate-900">
													{result.peakDemand.totalEligibleDays
														? formatDemand(
																result.peakDemand.averageWattsPerHour,
															).replace(/ (W\/h|kW\/h)$/, "")
														: "—"}
												</div>
												{result.peakDemand.totalEligibleDays ? (
													<div className="pb-1 text-sm font-bold uppercase tracking-wide text-slate-400">
														{result.peakDemand.averageWattsPerHour >= 1000
															? "kW/h average demand"
															: "W/h average demand"}
													</div>
												) : null}
											</div>
											<p className="mt-2 max-w-2xl text-sm text-slate-500">
												Average daytime demand across the full peak period for
												each complete day in the dataset.
											</p>
										</div>
										<div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
											<Zap size={28} />
										</div>
									</div>
									<div className="mt-6 grid grid-cols-1 gap-4 border-t border-slate-100 pt-6 sm:grid-cols-3">
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Avg Peak Usage
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.peakDemand.totalEligibleDays
													? `${result.peakDemand.averageUsage.toFixed(2)} kWh`
													: "Not enough data"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Mode
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.peakDemand.totalEligibleDays
													? formatDemand(result.peakDemand.modeWattsPerHour)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Median
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.peakDemand.totalEligibleDays
													? formatDemand(result.peakDemand.medianWattsPerHour)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Lowest
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.peakDemand.totalEligibleDays
													? formatDemand(result.peakDemand.lowestWattsPerHour)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
												Highest
											</div>
											<div className="mt-2 text-2xl font-bold text-slate-800">
												{result.peakDemand.totalEligibleDays
													? formatDemand(result.peakDemand.highestWattsPerHour)
													: "—"}
											</div>
										</div>
									</div>
								</div>
							</div>

						{/* Timeline */}
						<div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
							<div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
								<h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
									<BarChart3 size={20} className="text-blue-600" />
									Consumption History
								</h3>
								<div className="flex bg-slate-100 p-1 rounded-lg">
									{["total", "peak", "offPeak"].map((id) => (
										<button
											key={id}
											onClick={() => setHistoryView(id)}
											className={`px-4 py-1.5 rounded-md text-xs font-bold uppercase transition-all ${historyView === id ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700"}`}
										>
											{id}
										</button>
									))}
								</div>
							</div>
							<div className="relative h-64 flex items-end">
								<div className="absolute left-0 top-0 h-full flex flex-col justify-between text-[10px] text-slate-400 border-l pl-2 border-slate-100 pointer-events-none">
									<span>{timelineMax.toFixed(1)} kWh</span>
									<span>0</span>
								</div>
								<div className="flex-1 h-full flex items-end ml-10 gap-px">
									{result.dailyArray.map((day, idx) => {
										const val =
											historyView === "total"
												? day.peak + day.offPeak
												: historyView === "peak"
													? day.peak
													: day.offPeak;
										const h = (val / timelineMax) * 100;
										const barColor = day.isWeekend
											? historyView === "peak"
												? "bg-rose-300"
												: historyView === "offPeak"
													? "bg-emerald-300"
													: "bg-blue-300"
											: historyView === "peak"
												? "bg-rose-500"
												: historyView === "offPeak"
													? "bg-emerald-500"
													: "bg-blue-600";
										return (
											<div
												key={idx}
												className="flex-1 h-full flex flex-col justify-end group relative min-w-[1px]"
											>
												<div
													className={`w-full rounded-t-[1px] transition-all ${barColor} group-hover:brightness-75`}
													style={{
														height: `${Math.max(1, isNaN(h) ? 0 : h)}%`,
													}}
												/>
												<div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] py-2 px-3 rounded shadow-xl pointer-events-none whitespace-nowrap z-50">
													<div className="font-bold border-b border-slate-600 pb-1 mb-1">
														{day.date}
													</div>
													<div>{val.toFixed(2)} kWh</div>
												</div>
											</div>
										);
									})}
								</div>
							</div>
							<div className="flex justify-between text-[10px] text-slate-400 mt-4 border-t pt-2 ml-10 font-medium">
								<span>{result.dailyArray[0]?.date}</span>
								<span>{result.daysAnalyzed} Days of Historical Data</span>
								<span>
									{result.dailyArray[result.dailyArray.length - 1]?.date}
								</span>
							</div>
						</div>

						{/* Cost Breakdown */}
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
							<div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 flex flex-col">
								<div className="flex items-center justify-between mb-8">
									<h3 className="text-lg font-semibold text-slate-800">
										Bill Impact
									</h3>
									<PoundSterling className="text-slate-300" size={24} />
								</div>
								<div className="space-y-8 flex-1">
									<div className="border-b border-slate-50 pb-6">
										<div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">
											Annual Spend
										</div>
										<div className="flex justify-between items-end">
											<div>
												<div className="text-xs font-bold text-slate-400 uppercase mb-1">
													Current Year
												</div>
												<div className="text-2xl font-bold text-slate-800">
													{formatCurrency(result.currentAnnualCost)}
												</div>
											</div>
											<div className="text-right">
												<div className="text-xs font-bold text-emerald-500 uppercase mb-1">
													With Battery
												</div>
												<div className="text-2xl font-bold text-emerald-700">
													{formatCurrency(result.newAnnualCost)}
												</div>
											</div>
										</div>
									</div>
									<div className="bg-emerald-50 p-6 rounded-2xl border border-emerald-100 flex items-center gap-4">
										<div className="bg-white p-3 rounded-xl text-emerald-600 shadow-sm">
											<TrendingDown size={28} />
										</div>
										<div>
											<div className="text-sm font-bold text-slate-800">
												Net Reduction
											</div>
											<div className="text-2xl font-black text-emerald-600">
												{formatCurrency(result.annualSavings)} / year
											</div>
											<div className="text-xs text-emerald-600/80 font-bold uppercase tracking-wide">
												Approx{" "}
												{calculatePercentage(
													result.weeklySavings,
													result.currentWeeklyCost,
												)}
												% reduction in bills
											</div>
										</div>
									</div>
								</div>
							</div>

							{/* Profile */}
							<div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100">
								<div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
									<h3 className="text-lg font-semibold text-slate-800">
										24hr Average Profile
									</h3>
									<div className="flex bg-slate-100 p-1 rounded-lg">
										{["all", "weekday", "weekend"].map((id) => (
											<button
												key={id}
												onClick={() => setProfileView(id)}
												className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase transition-all ${profileView === id ? "bg-white shadow-sm text-slate-900" : "text-slate-400 hover:text-slate-600"}`}
											>
												{id}
											</button>
										))}
									</div>
								</div>
								<div className="relative h-48 flex items-end">
									<div className="absolute left-0 top-0 h-full flex flex-col justify-between text-[10px] text-slate-400 border-l pl-2 border-slate-100 pointer-events-none">
										<span>{profileMax.toFixed(2)} kWh</span>
										<span>0</span>
									</div>
									<div className="flex-1 h-full flex items-end ml-10 gap-[2px]">
										{result.profiles[profileView].map((val, idx) => {
											const h = (val / profileMax) * 100;
											const isPeakSlot = idx >= 11 && idx < 47;
											return (
												<div
													key={idx}
													className="flex-1 group relative h-full flex flex-col justify-end"
												>
													<div
														className={`w-full rounded-t-sm transition-all ${isPeakSlot ? "bg-rose-400 group-hover:bg-rose-500" : "bg-emerald-400 group-hover:bg-emerald-500"}`}
														style={{
															height: `${Math.max(2, isNaN(h) ? 0 : h)}%`,
														}}
													/>
													<div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] py-1 px-2 rounded pointer-events-none whitespace-nowrap z-50">
														{Math.floor(idx / 2)
															.toString()
															.padStart(2, "0")}
														:{idx % 2 === 1 ? "30" : "00"} — {val.toFixed(3)}{" "}
														kWh
													</div>
												</div>
											);
										})}
									</div>
								</div>
								<div className="flex justify-between text-[10px] text-slate-400 mt-4 font-bold ml-10 border-t pt-2 uppercase tracking-tighter">
									<span>Midnight</span>
									<span>6am</span>
									<span>Noon</span>
									<span>6pm</span>
									<span>11:30pm</span>
								</div>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
