using System.Text.Json.Serialization;

namespace ITrack.api.Services;

public class AdzunaSearchResponse
{
    [JsonPropertyName("results")]
    public List<AdzunaJobResult> Results { get; set; } = new();
}

public class AdzunaJobResult
{
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("salary_min")]
    public double? SalaryMin { get; set; }

    [JsonPropertyName("salary_max")]
    public double? SalaryMax { get; set; }

    [JsonPropertyName("location")]
    public AdzunaLocation? Location { get; set; }

    [JsonPropertyName("created")]
    public string? Created { get; set; }

    [JsonPropertyName("redirect_url")]
    public string? RedirectUrl { get; set; }

    [JsonPropertyName("company")]
    public AdzunaCompany? Company { get; set; }
}

public class AdzunaLocation
{
    [JsonPropertyName("display_name")]
    public string? DisplayName { get; set; }
}

public class AdzunaCompany
{
    [JsonPropertyName("display_name")]
    public string? DisplayName { get; set; }
}

